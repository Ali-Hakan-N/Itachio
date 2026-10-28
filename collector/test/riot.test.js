const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMatch, patchOf } = require('../src/riot/parse');
const { score } = require('../src/riot/score');
const { RiotClient, RiotKeyError, RateLimiter } = require('../src/riot/client');
const { crawl } = require('../src/riot/crawl');

const POS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
function fakeMatch(id, { queue = 440, duration = 1800, version = '16.21.712.5555', champs, blueWins = true } = {}) {
  const ids = champs || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  return {
    metadata: { matchId: id },
    info: {
      queueId: queue, gameDuration: duration, gameVersion: version, gameStartTimestamp: 1761700000000,
      teams: [{ teamId: 100, bans: [{ championId: 50 }, { championId: -1 }] }, { teamId: 200, bans: [{ championId: 51 }] }],
      participants: ids.map((c, i) => ({
        championId: c, teamId: i < 5 ? 100 : 200, teamPosition: POS[i % 5], win: i < 5 ? blueWins : !blueWins,
        gameEndedInEarlySurrender: false,
      })),
    },
  };
}

// ---------------- parse ----------------
test('patch is taken from the version', () => {
  assert.equal(patchOf('16.21.712.5555'), '16.21');
  assert.equal(patchOf('16.21.1'), '16.21');
  assert.equal(patchOf(''), null);
});

test('match converts to ingest format; remakes and other queues are skipped', () => {
  const m = parseMatch(fakeMatch('TR1_1'));
  assert.equal(m.id, 'TR1_1');
  assert.equal(m.platform, 'TR1');
  assert.equal(m.patch, '16.21');
  assert.equal(m.queue, 440);
  assert.deepEqual(m.b, [50, 51]);
  assert.deepEqual(m.p[2], { c: 3, r: 'middle', t: 100, w: true });
  assert.equal(parseMatch(fakeMatch('TR1_2', { duration: 200 })), null);
  assert.equal(parseMatch(fakeMatch('TR1_3', { queue: 450 })), null);
  assert.equal(parseMatch(null), null);
});

// ---------------- score ----------------
// 3 mid laners: 1 strong, 2 average, 3 weak; plenty of games
function aggregates() {
  return {
    matches: 3000,
    champ: [
      { champion_id: 1, role: 'middle', games: 1000, wins: 560 },
      { champion_id: 2, role: 'middle', games: 1000, wins: 500 },
      { champion_id: 3, role: 'middle', games: 1000, wins: 440 },
      { champion_id: 4, role: 'jungle', games: 1500, wins: 750 },
      { champion_id: 5, role: 'jungle', games: 1500, wins: 750 },
      { champion_id: 9, role: 'middle', games: 10, wins: 9 }, // too few games: not listed
    ],
    bans: [{ champion_id: 1, bans: 600 }],
    duo: [
      // 2 + 4: expected ~50%, observed 60% -> synergy
      { champion_id: 2, role: 'middle', ally_id: 4, games: 500, wins: 300 },
      // 1 + 5: 1 is already strong (~56%); winning 56% is not synergy
      { champion_id: 1, role: 'middle', ally_id: 5, games: 500, wins: 280 },
    ],
    lane: [
      // 2 vs 1: expected ~44%, observed 50% -> 2 is strong
      { champion_id: 2, role: 'middle', opponent_id: 1, games: 400, wins: 200 },
      // 3 vs 2: expected ~44%, observed 34% -> 3 is weak
      { champion_id: 3, role: 'middle', opponent_id: 2, games: 400, wins: 136 },
    ],
  };
}

test('meta: strong champion on top, scores 0-100, low sample left out', () => {
  const { meta } = score(aggregates());
  const mid = meta.filter((m) => m.role === 'middle').sort((a, b) => b.score - a.score);
  assert.deepEqual(mid.map((m) => m.champion), [1, 2, 3]);
  assert.ok(mid.every((m) => m.score >= 0 && m.score <= 100));
  assert.ok(mid[0].score > 50 && mid[2].score < 50);
  assert.equal(mid[0].win_rate, 56);
  assert.equal(mid[0].ban_rate, 20);
  assert.ok(!meta.some((m) => m.champion === 9));
});

test('synergy is measured as deviation from expected', () => {
  const { synergy } = score(aggregates());
  const good = synergy.find((s) => s.champion === 2 && s.ally === 4);
  assert.ok(good && good.strength > 0.5);
  assert.ok(!synergy.some((s) => s.champion === 1 && s.ally === 5));
});

test('matchup works both ways: strong +, weak -', () => {
  const { matchup } = score(aggregates());
  assert.ok(matchup.find((m) => m.champion === 2 && m.opponent === 1).strength > 0);
  assert.ok(matchup.find((m) => m.champion === 3 && m.opponent === 2).strength < 0);
  assert.ok(matchup.every((m) => m.strength >= -1 && m.strength <= 1));
});

test('a low-sample pair gets a weak effect', () => {
  const agg = aggregates();
  agg.duo = [{ champion_id: 2, role: 'middle', ally_id: 4, games: 20, wins: 12 }];
  const few = score(agg).synergy.find((s) => s.ally === 4)?.strength || 0;
  agg.duo = [{ champion_id: 2, role: 'middle', ally_id: 4, games: 2000, wins: 1200 }];
  const many = score(agg).synergy.find((s) => s.ally === 4).strength;
  assert.ok(few < many);
});

test('no matches gives an empty result', () => {
  assert.deepEqual(score({ matches: 0, champ: [], bans: [], duo: [], lane: [] }), { meta: [], synergy: [], matchup: [] });
});

// ---------------- client ----------------
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = responses.shift();
    return {
      ok: r.status === 200, status: r.status,
      headers: { get: (h) => (h === 'retry-after' ? r.retryAfter : null) },
      json: async () => r.body,
    };
  };
  fn.calls = calls;
  return fn;
}

test('client: waits and retries after 429, returns null on 404', async () => {
  const sleeps = [];
  const fetch = fakeFetch([{ status: 429, retryAfter: '2' }, { status: 200, body: { ok: 1 } }, { status: 404 }]);
  let now = 0;
  const api = new RiotClient({ key: 'k', fetch, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
  assert.deepEqual(await api.get('europe', '/x', { a: 1 }), { ok: 1 });
  assert.equal(await api.get('europe', '/y'), null);
  assert.equal(fetch.calls[0], 'https://europe.api.riotgames.com/x?a=1');
  assert.ok(sleeps.some((ms) => ms >= 2000));
});

test('client: stops the run on an invalid key', async () => {
  const api = new RiotClient({ key: 'k', fetch: fakeFetch([{ status: 403 }]), sleep: async () => {} });
  await assert.rejects(api.get('tr1', '/x'), RiotKeyError);
});

test('rate limiter never exceeds the window', async () => {
  let now = 0;
  const lim = new RateLimiter([[2, 1000]], { now: () => now, sleep: async (ms) => { now += ms; } });
  const at = [];
  for (let i = 0; i < 5; i++) {
    await lim.acquire();
    at.push(now);
  }
  // at most 2 requests in any 1 s window
  for (let i = 2; i < at.length; i++) assert.ok(at[i] - at[i - 2] >= 1000);
});

// ---------------- crawl ----------------
test('crawl: Flex first; duplicates and other-patch matches do not count', async () => {
  const matches = {
    EUW1_1: fakeMatch('EUW1_1', { queue: 440 }),
    EUW1_2: fakeMatch('EUW1_2', { queue: 440 }),
    EUW1_3: fakeMatch('EUW1_3', { queue: 440, version: '16.20.1' }),
    EUW1_9: fakeMatch('EUW1_9', { queue: 420 }),
  };
  const order = [];
  const api = {
    get: async (host, path, q) => {
      if (path.includes('/lol/league/v4/')) {
        const flex = path.includes('FLEX');
        return path.includes('entries') ? [] : { entries: [{ puuid: flex ? 'pf' : 'ps' }] };
      }
      if (path.endsWith('/ids')) {
        order.push(q.queue);
        return q.queue === 440 ? ['EUW1_1', 'EUW1_2', 'EUW1_3', 'EUW1_1'] : ['EUW1_9', 'EUW1_2'];
      }
      return matches[path.split('/').pop()];
    },
  };
  const ingested = [];
  const stats = await crawl({
    api, patch: '16.21', platforms: ['euw1'], deadline: Date.now() + 60_000, since: 0, maxPerRegion: 0,
    filterUnseen: async (ids) => ids,
    ingest: async (m) => { ingested.push(...m); return m.length; },
    log: () => {}, random: () => 0,
  });
  assert.deepEqual(order, [440, 420]);
  assert.deepEqual(ingested.map((m) => m.id), ['EUW1_1', 'EUW1_2', 'EUW1_9']);
  assert.equal(stats.europe.byQueue.Flex, 2);
  assert.equal(stats.europe.byQueue['Solo/Duo'], 1);
  assert.equal(stats.europe.otherPatch, 1);
});
