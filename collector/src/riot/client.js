// Riot API client. Keeps a separate rate limiter per host (tr1, europe, ...),
// because Riot's limits are per host too. On 429 it waits for Retry-After, on 5xx
// it retries a few times, and on an invalid key (401/403) it stops the whole run.

class RiotKeyError extends Error {}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

// "20:1,100:120" -> [[20, 1000], [100, 120000]]  (requests : seconds)
function parseLimits(spec) {
  return String(spec)
    .split(',')
    .map((part) => part.split(':').map(Number))
    .filter(([n, s]) => n > 0 && s > 0)
    .map(([n, s]) => [n, s * 1000]);
}

class RateLimiter {
  constructor(windows, { now = Date.now, sleep = sleepReal } = {}) {
    this.windows = windows;
    this.maxWindow = Math.max(...windows.map((w) => w[1]));
    this.stamps = [];
    this.pausedUntil = 0;
    this.chain = Promise.resolve();
    this.now = now;
    this.sleep = sleep;
  }

  // Lets requests through one at a time, each when every window has room
  acquire() {
    const turn = this.chain.then(() => this.#waitForSlot());
    this.chain = turn.catch(() => {});
    return turn;
  }

  pause(ms) {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  async #waitForSlot() {
    for (;;) {
      const now = this.now();
      this.stamps = this.stamps.filter((t) => now - t < this.maxWindow);
      let wait = Math.max(0, this.pausedUntil - now);
      for (const [limit, ms] of this.windows) {
        const inWindow = this.stamps.filter((t) => now - t < ms);
        if (inWindow.length >= limit) wait = Math.max(wait, ms - (now - inWindow[inWindow.length - limit]) + 10);
      }
      if (wait === 0) {
        this.stamps.push(now);
        return;
      }
      await this.sleep(wait);
    }
  }
}

class RiotClient {
  constructor({ key, limits = '20:1,100:120', fetch = globalThis.fetch, sleep = sleepReal, now = Date.now, log = () => {} }) {
    if (!key) throw new RiotKeyError('RIOT_API_KEY is not set');
    this.key = key;
    this.windows = parseLimits(limits);
    this.fetch = fetch;
    this.sleep = sleep;
    this.now = now;
    this.log = log;
    this.limiters = new Map();
    this.requests = 0;
  }

  #limiter(host) {
    if (!this.limiters.has(host)) this.limiters.set(host, new RateLimiter(this.windows, { now: this.now, sleep: this.sleep }));
    return this.limiters.get(host);
  }

  /** host: "tr1", "europe"... · returns null on 404 */
  async get(host, path, query = {}) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString();
    const url = `https://${host}.api.riotgames.com${path}${qs ? `?${qs}` : ''}`;
    const limiter = this.#limiter(host);

    for (let attempt = 1; ; attempt++) {
      await limiter.acquire();
      this.requests++;
      let res;
      try {
        res = await this.fetch(url, { headers: { 'X-Riot-Token': this.key } });
      } catch (err) {
        if (attempt >= 4) throw new Error(`${host}${path}: connection failed (${err.message})`);
        await this.sleep(2000 * attempt);
        continue;
      }

      if (res.ok) return res.json();
      if (res.status === 404) return null;
      if (res.status === 401 || res.status === 403) {
        throw new RiotKeyError('Riot API key is invalid or expired (development keys must be renewed every 24 hours)');
      }
      if (res.status === 429 && attempt < 6) {
        const retryAfter = Number(res.headers.get('retry-after')) || 10;
        this.log(`${host}: rate limited, waiting ${retryAfter}s`);
        limiter.pause(retryAfter * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < 4) {
        await this.sleep(2000 * attempt);
        continue;
      }
      throw new Error(`${host}${path}: HTTP ${res.status}`);
    }
  }
}

module.exports = { RiotClient, RiotKeyError, RateLimiter, parseLimits };
