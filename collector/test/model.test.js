const test = require('node:test');
const assert = require('node:assert/strict');
const { toCompact, roleShares, features } = require('../src/model/features');
const { train } = require('../src/model/train');
const { exportModel } = require('../src/model');

const ctx = { share: new Map(), tagOf: (id) => (id % 2 ? 'Mage' : 'Tank') };

test('compact match needs every role once per team', () => {
  const p = (c, r, t, w) => ({ c, r, t, w });
  const roles = ['top', 'jungle', 'middle', 'bottom', 'utility'];
  const full = { id: 'X_1', queue: 440, p: [...roles.map((r, i) => p(i + 1, r, 100, true)), ...roles.map((r, i) => p(i + 11, r, 200, false))] };
  assert.deepEqual(toCompact(full), { id: 'X_1', q: 440, w: 1, b: [1, 2, 3, 4, 5], r: [11, 12, 13, 14, 15] });
  const missing = { ...full, p: full.p.map((x, i) => (i === 0 ? { ...x, r: '' } : x)) };
  assert.equal(toCompact(missing), null);
});

test('features: pair keys are canonical, matchups flip sign by side', () => {
  const m = { b: [1, 2, 3, 4, 5], r: [11, 12, 13, 14, 15] };
  const swapped = { b: m.r, r: m.b };
  const f = new Map(features(m, ctx));
  const g = new Map(features(swapped, ctx));
  assert.equal(f.get('c:1:0'), 1);
  assert.equal(g.get('c:1:0'), -1);
  assert.equal(f.get('s:1:0:2:1'), 1);
  assert.equal(f.get('v:1:0:11:0'), 1);
  assert.equal(g.get('v:1:0:11:0'), -1); // same matchup seen from the other side
  assert.ok(f.has('o:0'));
});

test('role shares come from the matches', () => {
  const { share } = roleShares([{ b: [1, 2, 3, 4, 5], r: [6, 7, 8, 9, 10] }, { b: [2, 1, 3, 4, 5], r: [6, 7, 8, 9, 10] }]);
  assert.equal(share.get('1:0'), 0.5);
  assert.equal(share.get('3:2'), 1);
});

// Synthetic matches with known effects: champion 1 top is strong, 2 mid + 3 jungle
// on the same team win more, and 4 bot beats 5 bot.
function synthetic(n, seed = 7) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = (pool, used) => {
    for (;;) {
      const c = pool[Math.floor(rand() * pool.length)];
      if (!used.has(c)) return used.add(c), c;
    }
  };
  const pools = [[1, 21, 22, 23], [3, 31, 32, 33], [2, 41, 42, 43], [4, 5, 51, 52], [61, 62, 63, 64]];
  const out = [];
  for (let i = 0; i < n; i++) {
    const used = new Set();
    const b = pools.map((p) => pick(p, used));
    const r = pools.map((p) => pick(p, used));
    let z = 0;
    z += (b[0] === 1) * 0.8 - (r[0] === 1) * 0.8;
    z += (b[2] === 2 && b[1] === 3) * 0.7 - (r[2] === 2 && r[1] === 3) * 0.7;
    z += (b[3] === 4 && r[3] === 5) * 0.9 - (r[3] === 4 && b[3] === 5) * 0.9;
    out.push({ id: `S_${i}`, q: 440, w: rand() < 1 / (1 + Math.exp(-z)) ? 1 : 0, b, r });
  }
  return out;
}

test('training finds the planted strength, synergy and matchup', () => {
  const matches = synthetic(6000);
  const { share } = roleShares(matches);
  const model = train(matches, { share, tagOf: () => 'None' }, { grid: { c: [1e-3], pair: [3e-3] }, refine: false, iters: 200 });
  const w = new Map(model.keys.map((k, i) => [k, model.w[i]]));
  assert.ok(w.get('c:1:0') > 0.3, `strength ${w.get('c:1:0')}`);
  assert.ok(w.get('s:2:2:3:1') > 0.2, `synergy ${w.get('s:2:2:3:1')}`);
  assert.ok(w.get('v:4:3:5:3') > 0.3, `matchup ${w.get('v:4:3:5:3')}`);
  assert.ok(model.metrics.logloss < model.metrics.baseLogloss);
  assert.ok(model.keys.every((k, i) => !k.startsWith('o:') || model.w[i] <= 0), 'off-role weights must not be positive');

  const data = exportModel(model, { share, games: roleShares(matches).games, tags: new Map(), patch: 'T', matches: matches.length });
  assert.ok(data.champ['1:0'][0] > 0.3);
  assert.ok(data.vs.some(([a, ra, b, rb, wt]) => a === 4 && ra === 3 && b === 5 && rb === 3 && wt > 0.3));
});

test('worker: trains in a background thread, and stops when asked', async () => {
  const { trainInWorker } = require('../src/model');
  const matches = synthetic(2500);
  const { share } = roleShares(matches);
  const done = await trainInWorker({ matches, share, tags: new Map(), log: () => {}, shouldStop: async () => false });
  assert.ok(done && done.keys.length > 0 && done.w.length === done.keys.length);

  const stopped = await trainInWorker({ matches, share, tags: new Map(), log: () => {}, shouldStop: async () => true, pollMs: 5 });
  assert.equal(stopped, null);
});
