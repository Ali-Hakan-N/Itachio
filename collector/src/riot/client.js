// Riot API client. Keeps a separate rate limiter per host (tr1, europe, ...),
// because Riot's limits are per host too. On 429 it waits for Retry-After, on 5xx
// it retries a few times, and on an invalid key (401/403) it stops the whole run.
// When the connection is lost it waits for the network (up to OFFLINE_MAX_MS) instead
// of giving up, so an internet outage does not end the day's collecting.
// Priority: work run through first() goes ahead of everything else. While it runs, other
// requests do not start (one already waiting for its turn may still go first).

class RiotKeyError extends Error {}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const OFFLINE_MAX_MS = 3 * 60 * 60_000;
const OFFLINE_WAIT_MS = 60_000;
const PRIORITY_POLL_MS = 250;

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

  setWindows(windows) {
    this.windows = windows;
    this.maxWindow = Math.max(...windows.map((w) => w[1]));
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
    this.limitSpec = String(limits);
    this.urgent = 0; // priority work running
  }

  /** Runs fn(api) ahead of every other request: api is this client with priority */
  async first(fn) {
    this.urgent++;
    try {
      return await fn({ get: (host, path, query) => this.get(host, path, query, { priority: true }) });
    } finally {
      this.urgent--;
    }
  }

  // Riot reports the key's real limits in X-App-Rate-Limit ("20:1,100:120").
  // Adopting them uses a personal or production key to the full without any setting.
  #adoptLimits(res) {
    const spec = res.headers.get('x-app-rate-limit');
    if (!spec || spec === this.limitSpec) return;
    const windows = parseLimits(spec);
    if (!windows.length) return;
    this.limitSpec = spec;
    this.windows = windows;
    for (const l of this.limiters.values()) l.setWindows(windows);
    this.log(`rate limit from Riot: ${spec}`);
  }

  #limiter(host) {
    if (!this.limiters.has(host)) this.limiters.set(host, new RateLimiter(this.windows, { now: this.now, sleep: this.sleep }));
    return this.limiters.get(host);
  }

  /** host: "tr1", "europe"... · returns null on 404 */
  async get(host, path, query = {}, { priority = false } = {}) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString();
    const url = `https://${host}.api.riotgames.com${path}${qs ? `?${qs}` : ''}`;
    const limiter = this.#limiter(host);

    while (!priority && this.urgent > 0) await this.sleep(PRIORITY_POLL_MS);
    for (let attempt = 1; ; attempt++) {
      await limiter.acquire();
      this.requests++;
      let res;
      try {
        res = await this.fetch(url, { headers: { 'X-Riot-Token': this.key } });
      } catch (err) {
        if (attempt < 4) {
          await this.sleep(2000 * attempt);
          continue;
        }
        // Still failing: most likely the network is down. Wait for it.
        const since = (this.offlineSince ??= this.now());
        if (this.now() - since > OFFLINE_MAX_MS) throw new Error(`${host}${path}: connection failed (${err.message})`);
        if (!this.offlineLogged) this.log(`connection lost (${err.message}), waiting for the network`);
        this.offlineLogged = true;
        await this.sleep(OFFLINE_WAIT_MS);
        continue;
      }
      if (this.offlineSince !== undefined) {
        if (this.offlineLogged) this.log(`connection back after ${Math.round((this.now() - this.offlineSince) / 60_000)} min`);
        this.offlineSince = undefined;
        this.offlineLogged = false;
      }

      this.#adoptLimits(res);
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
