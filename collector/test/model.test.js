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

// Synthetic matches: champion 1 top is strong; optionally 2 mid + 3 jungle on the same
// team win more, and 4 bot beats 5 bot.
function synthetic(n, { pairs = true, seed = 7 } = {}) {
  let s = seed;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
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
    let z = (b[0] === 1) * 0.8 - (r[0] === 1) * 0.8;
    if (pairs) {
      z += (b[2] === 2 && b[1] === 3) * 0.7 - (r[2] === 2 && r[1] === 3) * 0.7;
      z += (b[3] === 4 && r[3] === 5) * 0.9 - (r[3] === 4 && b[3] === 5) * 0.9;
    }
    out.push({ id: `S_${i}`, q: 440, w: rand() < 1 / (1 + Math.exp(-z)) ? 1 : 0, b, r });
  }
  return out;
}
const FAST = { folds: 3, tuneIters: 120, finalIters: 250 };

test('training keeps proven layers and finds the planted strength, synergy and matchup', () => {
  const matches = synthetic(6000);
  const { share, games } = roleShares(matches);
  const model = train(matches, { share, tagOf: () => 'None' }, FAST);
  const kept = Object.fromEntries(model.metrics.layers.map((l) => [l.name, l.accepted]));
  assert.ok(kept.synergy, 'synergy layer kept');
  assert.ok(kept.matchup, 'matchup layer kept');
  const w = new Map(model.keys.map((k, i) => [k, model.w[i]]));
  // Strength is only identified relative to the other champions of the role
  const strength = w.get('c:1:0') - (w.get('c:21:0') + w.get('c:22:0') + w.get('c:23:0')) / 3;
  assert.ok(strength > 0.5, `strength ${strength}`);
  assert.ok(w.get('s:2:2:3:1') > 0.25, `synergy ${w.get('s:2:2:3:1')}`);
  assert.ok(w.get('v:4:3:5:3') > 0.3, `matchup ${w.get('v:4:3:5:3')}`);
  assert.ok(model.metrics.logloss < model.metrics.baseLogloss);
  assert.ok(model.metrics.calibration.eceAfter < 0.05);
  assert.ok(model.keys.every((k, i) => !k.startsWith('o:') || model.w[i] <= 0), 'off-role weights must not be positive');
  assert.ok(model.se[model.keys.indexOf('c:1:0')] > 0, 'standard error computed');

  const data = exportModel(model, { share, games, tags: new Map(), patch: 'T', matches: matches.length });
  assert.ok(data.champ['1:0'][0] > 0.3 && data.champ['1:0'][3] > 0);
  assert.ok(data.vs.some(([a, ra, b, rb, wt]) => a === 4 && ra === 3 && b === 5 && rb === 3 && wt > 0.3));
  // Proven layers produce no temporary pairs
  assert.equal(data.synT.length, 0);
  assert.equal(data.vsT.length, 0);
});

test('training leaves out pair layers when the pairs are only noise', () => {
  const matches = synthetic(6000, { pairs: false, seed: 11 });
  const { share, games } = roleShares(matches);
  const model = train(matches, { share, tagOf: () => 'None' }, FAST);
  const kept = Object.fromEntries(model.metrics.layers.map((l) => [l.name, l.accepted]));
  assert.equal(kept.synergy, false);
  assert.equal(kept.matchup, false);
  const data = exportModel(model, { share, games, tags: new Map(), patch: 'T', matches: matches.length });
  assert.equal(data.syn.length, 0);
  assert.equal(data.vs.length, 0);
  // Temporary pairs: with only noise the false discovery control lets (almost) nothing through
  assert.ok(data.synT.length + data.vsT.length <= 2, `temporary ${data.synT.length} + ${data.vsT.length}`);
});

test('temporary pairs: real pairs of a layer that is not proven still come through', () => {
  const matches = synthetic(6000);
  const { share, games } = roleShares(matches);
  // Reject every pair layer on purpose
  const model = train(matches, { share, tagOf: () => 'None' }, { ...FAST, acceptSe: 1e9 });
  assert.ok(model.metrics.layers.slice(1).every((l) => !l.accepted));
  const data = exportModel(model, { share, games, tags: new Map(), patch: 'T', matches: matches.length });
  const find = (list, a, ra, b, rb) => list.find((x) => x[0] === a && x[1] === ra && x[2] === b && x[3] === rb);
  const syn = find(data.synT, 2, 2, 3, 1);
  const vs = find(data.vsT, 4, 3, 5, 3);
  assert.ok(syn && syn[4] > 0.1, `synergy ${syn}`);
  assert.ok(vs && vs[4] > 0.1, `matchup ${vs}`);
  for (const [, , , , w, se, n] of [...data.synT, ...data.vsT]) assert.ok(se > 0 && n >= 30 && Number.isFinite(w));
  // Few false pairs next to the planted ones
  assert.ok(data.synT.length + data.vsT.length <= 6, `temporary ${data.synT.length} + ${data.vsT.length}`);
});

test('worker: trains in a background thread, and stops when asked', async () => {
  const { trainInWorker } = require('../src/model');
  const matches = synthetic(2500);
  const { share } = roleShares(matches);
  const done = await trainInWorker({ matches, share, tags: new Map(), log: () => {}, shouldStop: async () => false, options: FAST });
  assert.ok(done && done.keys.length > 0 && done.w.length === done.keys.length);

  const stopped = await trainInWorker({ matches, share, tags: new Map(), log: () => {}, shouldStop: async () => true, pollMs: 5 });
  assert.equal(stopped, null);
});

// Matches with early data: 4 bot wins its lane against 5 bot, and 2 mid wins its lane
// against the enemy jungler 3 (a pair in different roles). The result depends on the
// lanes, so these pairs reach the result only through the early game.
function syntheticEarly(n, seed = 5) {
  let s = seed;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const pick = (pool, used) => {
    for (;;) {
      const c = pool[Math.floor(rand() * pool.length)];
      if (!used.has(c)) return used.add(c), c;
    }
  };
  const pools = [[1, 21, 22, 23], [3, 31, 32, 33], [2, 41, 42, 43], [4, 5, 51, 52], [61, 62, 63, 64]];
  const lane = (adv, sign) => {
    const cs = Math.round(70 + sign * 6 * adv);
    return [cs, 0, Math.max(0, Math.round(2 + sign * adv)), +(sign * adv > 0.5), +(sign * adv > 0.8), Math.max(0, Math.round(1 + sign * adv / 2)), 0];
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const used = new Set();
    const b = pools.map((p) => pick(p, used));
    const r = pools.map((p) => pick(p, used));
    const adv = [0, 1, 2, 3, 4].map(() => gauss());
    adv[3] += (b[3] === 4 && r[3] === 5) * 1.5 - (r[3] === 4 && b[3] === 5) * 1.5;
    adv[2] += (b[2] === 2 && r[1] === 3) * 1.5 - (r[2] === 2 && b[1] === 3) * 1.5;
    const z = (b[0] === 1) * 0.5 - (r[0] === 1) * 0.5 + 0.5 * adv.reduce((x, y) => x + y, 0);
    const w = rand() < 1 / (1 + Math.exp(-z)) ? 1 : 0;
    out.push({
      id: `E_${i}`, q: 440, w, b, r,
      lb: adv.map((a) => lane(a, 1)),
      lr: adv.map((a) => lane(a, -1)),
      f: [0, 0, 0, 0, 0].map(() => (rand() < 0.5 ? 1 : -1)),
    });
  }
  return out;
}

test('early game layer: pairs that matter through the lanes are learned and kept', () => {
  const matches = syntheticEarly(5000);
  const { share, games } = roleShares(matches);
  const model = train(matches, { share, tagOf: () => 'None' }, { ...FAST, earlyMinMatches: 1000 });
  const kept = Object.fromEntries(model.metrics.layers.map((l) => [l.name, l.accepted]));
  assert.ok(kept['early game'], 'early game layer kept');
  assert.ok(model.early.surrogate.accuracy > 0.6, `surrogate ${model.early.surrogate.accuracy}`);
  const data = exportModel(model, { share, games, tags: new Map(), patch: 'T', matches: matches.length });
  const find = (list, a, ra, b, rb) => list.find((x) => x[0] === a && x[1] === ra && x[2] === b && x[3] === rb);
  const bot = find(data.vsE, 4, 3, 5, 3);
  const cross = find(data.vsE, 2, 2, 3, 1);
  assert.ok(bot && bot[4] > 0.1, `bot lane ${bot}`);
  assert.ok(cross && cross[4] > 0.1, `mid against jungle ${cross}`);
  // The planted pairs are the strongest ones
  const top = [...data.vsE].sort((x, y) => Math.abs(y[4]) - Math.abs(x[4])).slice(0, 2).map((x) => x.slice(0, 4).join(':'));
  assert.deepEqual(top.sort(), ['2:2:3:1', '4:3:5:3']);
  assert.ok(data.early.kept && data.early.kappa.v > 0 && 'c' in data.early.kappa);
});

test('early game layer is skipped without enough early data', () => {
  const matches = synthetic(2500);
  const { share } = roleShares(matches);
  const model = train(matches, { share, tagOf: () => 'None' }, FAST);
  assert.equal(model.early, null);
  assert.ok(!model.metrics.layers.some((l) => l.name === 'early game'));
});

test('bans are kept in compact matches and turned into ban rates', () => {
  const { banRates } = require('../src/model');
  const roles = ['top', 'jungle', 'middle', 'bottom', 'utility'];
  const parsed = { id: 'B_1', queue: 440, b: [7, 8], p: roles.flatMap((r, i) => [{ c: i + 1, r, t: 100, w: true }, { c: i + 11, r, t: 200, w: false }]) };
  assert.deepEqual(toCompact(parsed).x, [7, 8]);
  const many = Array.from({ length: 600 }, (_, i) => ({ x: i % 3 === 0 ? [7, 7] : [8] }));
  const rates = banRates(many);
  assert.equal(rates[7], 0.3333); // counted once per match
  assert.equal(rates[8], 0.6667);
  assert.equal(banRates(many.slice(0, 100)), null); // too few matches with bans
});
