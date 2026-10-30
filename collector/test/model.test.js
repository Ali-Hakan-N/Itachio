const test = require('node:test');
const assert = require('node:assert/strict');
const { toCompact, roleShares, features } = require('../src/model/features');
const { train, design } = require('../src/model/train');
const { exportModel, resolveTrainMatchLimit } = require('../src/model');

const ctx = { share: new Map(), tagOf: (id) => (id % 2 ? 'Mage' : 'Tank') };

test('compact match needs every role once per team', () => {
  const p = (c, r, t, w) => ({ c, r, t, w });
  const roles = ['top', 'jungle', 'middle', 'bottom', 'utility'];
  const full = { id: 'X_1', patch: '16.21', start: 1790000000000, queue: 440, p: [...roles.map((r, i) => p(i + 1, r, 100, true)), ...roles.map((r, i) => p(i + 11, r, 200, false))] };
  assert.deepEqual(toCompact(full), { id: 'X_1', q: 440, w: 1, b: [1, 2, 3, 4, 5], r: [11, 12, 13, 14, 15], t: 1790000000000, patch: '16.21' });
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

test('sparse design matrix uses exact typed-array storage for feature entries', () => {
  const matches = synthetic(20);
  const D = design(matches, ctx, 5);

  assert.equal(D.rowPtr.length, matches.length + 1);
  assert.equal(D.rowPtr.at(-1), D.cols.length);
  assert.equal(D.cols.length, D.vals.length);
  for (let r = 0; r < matches.length; r++) {
    assert.equal(D.rowPtr[r + 1] - D.rowPtr[r], features(matches[r], ctx).length);
  }
});

test('training match limit defaults to 300k, supports 500k, and hard-caps at one million', () => {
  assert.equal(resolveTrainMatchLimit(''), 300000);
  assert.equal(resolveTrainMatchLimit('500000'), 500000);
  assert.equal(resolveTrainMatchLimit('1000000'), 1000000);
  assert.equal(resolveTrainMatchLimit('2000000'), 1000000);
  assert.equal(resolveTrainMatchLimit('500'), 2000);
  assert.equal(resolveTrainMatchLimit('not-a-number'), 300000);
});

test('composition pillars are side-symmetric and capture damage balance, frontline and control proxies', () => {
  const tagOf = (id) => ({ 1: 'Mage', 2: 'Marksman', 3: 'Tank', 4: 'Fighter', 5: 'Support', 11: 'Marksman', 12: 'Marksman', 13: 'Assassin', 14: 'Assassin', 15: 'Fighter' })[id] || 'None';
  const blue = { b: [1, 2, 3, 4, 5], r: [11, 12, 13, 14, 15] };
  const forward = new Map(features(blue, { share: new Map(), tagOf }));
  const reverse = new Map(features({ b: blue.r, r: blue.b }, { share: new Map(), tagOf }));

  for (const key of ['a:damageImbalance', 'a:frontline', 'a:control']) {
    assert.ok(forward.has(key));
    assert.equal(reverse.get(key), -forward.get(key));
  }
  assert.ok(forward.get('a:frontline') > 0);
  assert.ok(forward.get('a:control') > 0);
});

test('out-of-time model prediction includes composition styles and learned pillars', () => {
  const { matchLogit } = require('../src/model/predict');
  const base = {
    champ: {}, off: [0, 0, 0, 0, 0], bias: 0,
    tags: { 1: 'Tank', 3: 'Tank', 5: 'Tank', 7: 'Tank', 9: 'Tank', 2: 'Mage', 4: 'Mage', 6: 'Mage', 8: 'Mage', 10: 'Mage' },
  };
  const match = { b: [1, 3, 5, 7, 9], r: [2, 4, 6, 8, 10] };
  const enriched = {
    ...base,
    pillars: { damageImbalance: 0.3, frontline: 0.5, control: 0.2 },
    comp: { k: 1, U: Object.fromEntries([...match.b.map((c) => [c, [0.2]]), ...match.r.map((c) => [c, [-0.2]])]), a: [0.4], c: [0], m: [] },
  };
  const baseline = matchLogit(base)(match);
  const prediction = matchLogit(enriched)(match);
  const reversed = matchLogit(enriched)({ b: match.r, r: match.b });

  assert.ok(prediction > baseline);
  assert.ok(Math.abs(prediction + reversed) < 1e-10);
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

test('training proves the planted strength, synergy and matchup', () => {
  const matches = synthetic(6000);
  const { share, games } = roleShares(matches);
  const model = train(matches, { share, tagOf: () => 'None' }, FAST);
  const proven = Object.fromEntries(model.metrics.layers.map((l) => [l.name, l.proven]));
  assert.ok(proven.synergy, 'synergy layer proven');
  assert.ok(proven.matchup, 'matchup layer proven');
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
  assert.deepEqual(Object.keys(data.pillars).sort(), ['control', 'damageImbalance', 'frontline']);
});

test('every layer is kept by default; noise pairs stay small', () => {
  const matches = synthetic(6000, { pairs: false, seed: 11 });
  const { share } = roleShares(matches);
  const model = train(matches, { share, tagOf: () => 'None' }, FAST);
  const byName = Object.fromEntries(model.metrics.layers.map((l) => [l.name, l]));
  assert.ok(byName.synergy.accepted && byName.matchup.accepted);
  assert.ok(!byName.synergy.proven && !byName.matchup.proven);
  // Tuned regularization keeps noise pairs near zero
  const pairW = model.keys.map((k, i) => [k, model.w[i]]).filter(([k]) => k.startsWith('s:') || k.startsWith('v:'));
  const big = pairW.filter(([, w]) => Math.abs(w) > 0.15).length;
  assert.ok(big <= 0.02 * pairW.length, `${big} of ${pairW.length} noise pairs above 0.15`);
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
  const proven = Object.fromEntries(model.metrics.layers.map((l) => [l.name, l.proven]));
  assert.ok(proven['early game'], 'early game layer proven');
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

test('counterpick tendency: lambda is found when picks follow matchups, 0 when they do not', () => {
  const { counterpickTendency } = require('../src/model/choice');
  // Roles hold champions r*10+1..r*10+4. In top, 2 beats red's jungle 13 strongly.
  const champ = {};
  for (let r = 0; r < 5; r++) for (let k = 1; k <= 4; k++) champ[`${r * 10 + k}:${r}`] = [0, 500, 1];
  const data = { matches: 1000, champ, vs: [[2, 0, 13, 1, 1]], tags: {} };
  let s = 3;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const make = (counterpicks) =>
    Array.from({ length: 3000 }, () => {
      const pick = (r) => r * 10 + 1 + Math.floor(rand() * 4);
      const b = [0, 1, 2, 3, 4].map(pick);
      const r = [0, 1, 2, 3, 4].map(pick);
      // When red's jungler is 13, blue top picks 2 most of the time
      if (counterpicks && r[1] === 13 && rand() < 0.7) b[0] = 2;
      return { b, r };
    });
  const tend = counterpickTendency(data, make(true));
  assert.ok(tend.lambda > 0.5, `lambda ${tend.lambda}`);
  const none = counterpickTendency(data, make(false));
  assert.ok(none.lambda < 2 * none.se + 0.05, `lambda ${none.lambda} ± ${none.se}`);
});

test('training set: the current patch, filled from older patches only up to enough', () => {
  const { pickTraining } = require('../src/model');
  const list = (patch, n) => ({ patch, matches: Array.from({ length: n }, (_, i) => `${patch}-${i}`) });
  const sizes = (parts) => Object.fromEntries(parts.map((p) => [p.patch, p.matches.length]));
  // Young patch: 10 of its own, 50 needed -> 40 from the newest older patch
  assert.deepEqual(sizes(pickTraining(list('16.22', 10), [list('16.21', 30), list('16.20', 100)], { enough: 50, max: 200 })), { '16.20': 10, '16.21': 30, '16.22': 10 });
  // Taken from the newest end of the older patch
  const parts = pickTraining(list('16.22', 10), [list('16.21', 100)], { enough: 50, max: 200 });
  assert.equal(parts[0].matches[0], '16.21-60');
  // Enough of its own: older patches are dropped, all of the current patch is used
  assert.deepEqual(sizes(pickTraining(list('16.22', 80), [list('16.21', 100)], { enough: 50, max: 200 })), { '16.22': 80 });
  // Never more than max
  assert.deepEqual(sizes(pickTraining(list('16.22', 300), [], { enough: 50, max: 200 })), { '16.22': 200 });
});

test('composition: finds a team-level style, and never makes the model worse', () => {
  let s = 9;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const pools = [[21, 22, 23, 24], [31, 32, 33, 34], [41, 42, 43, 44], [51, 52, 53, 54], [61, 62, 63, 64]];
  const tanks = new Set([21, 31, 61]);
  const matches = [];
  for (let i = 0; i < 8000; i++) {
    const pick = (p) => p[Math.floor(rand() * p.length)];
    const b = pools.map(pick);
    const r = pools.map((p) => p.filter((c) => !b.includes(c))[Math.floor(rand() * (p.length - 1))]);
    const has = (t) => (t.some((c) => tanks.has(c)) ? 1 : 0);
    const z = 0.8 * (has(b) - has(r));
    matches.push({ id: `T_${i}`, q: 440, w: rand() < 1 / (1 + Math.exp(-z)) ? 1 : 0, b, r });
  }
  // On its own (nothing else in the model) the tanks come out as one style
  const { compLayer, exportComp } = require('../src/model/comp');
  const y = Float64Array.from(matches, (m) => m.w);
  const fold = Uint8Array.from(matches, (_, i) => i % 3);
  const alone = compLayer(matches, y, new Float64Array(matches.length), fold, 3);
  assert.ok(alone.iters > 0);
  const { comp } = exportComp(alone);
  const found = Array.from({ length: comp.k }, (_, k) => {
    const ranked = Object.entries(comp.U).sort((x, z) => (z[1][k] - x[1][k]) * Math.sign(comp.a[k] || 1));
    return new Set(ranked.slice(0, 3).map(([c]) => Number(c)));
  }).some((top) => [...tanks].every((t) => top.has(t)));
  assert.ok(found, 'tanks found as a style');
  // On top of the full model, which already explains it with strength and pairs, it does no harm
  const { share } = roleShares(matches);
  const model = train(matches, { share, tagOf: () => 'None' }, FAST);
  const layer = model.metrics.layers.find((l) => l.name === 'composition');
  assert.ok(layer.improvement > -2 * layer.se - 1e-6, `composition ${layer.improvement} ± ${layer.se}`);
});
