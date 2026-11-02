import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RiotMatchV5 } from '../src/clickhouse.js';
import { exportGbdtOnnx, gbdtLogit, trainGbdt } from '../src/gbdt.js';
import { chronologicalSplit, fitSparseLayer, headToHead, HYBRID_FEATURE_NAMES, MASKED_FEATURES, saveHybrid, sparseFeatures, trainHybrid } from '../src/hybrid.js';
import { DraftPredictor } from '../src/predictor.js';
import { compactMatchToRiotMatch, indexMatch, makeHistory, type CompactMatch } from '../src/training-data.js';

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// y depends on x0 XOR x1 and nothing else: no single column says anything, as with a damage
// split that only matters against a given enemy team
function xorData(rows: number) {
  const next = random(5);
  const X = new Float32Array(rows * 3);
  const y = new Uint8Array(rows);
  for (let row = 0; row < rows; row++) {
    const a = next() > 0.5 ? 1 : 0;
    const b = next() > 0.5 ? 1 : 0;
    X[row * 3] = a;
    X[row * 3 + 1] = b;
    X[row * 3 + 2] = next();
    y[row] = next() < ((a ^ b) ? 0.9 : 0.1) ? 1 : 0;
  }
  const all = Int32Array.from({ length: rows }, (_, i) => i);
  return { X, y, train: all.subarray(0, Math.floor(rows * 0.8)), valid: all.subarray(Math.floor(rows * 0.8)) };
}

const fast = { trees: 60, learningRate: 0.2, minChildHessian: 5, featureFraction: 1, rowFraction: 1, l2: 1 };

test('the trees learn an interaction no single feature shows, and stop on the held-out set', () => {
  const { X, y, train, valid } = xorData(4000);
  const model = trainGbdt(X, y, 3, train, valid, fast);
  let hits = 0;
  for (const row of valid) hits += Number(gbdtLogit(model, X, row) >= 0) === y[row] ? 1 : 0;
  assert.ok(hits / valid.length > 0.85, `accuracy ${hits / valid.length}`);
  assert.ok(model.validationLogLoss < 0.45);
  assert.ok(model.trees.length <= 60);
  const stopped = trainGbdt(X, y, 3, train, valid, { ...fast, trees: 2000, earlyStoppingRounds: 5 });
  assert.ok(stopped.trees.length < 500, `${stopped.trees.length} trees`);
});

test('excluded columns are never split on', () => {
  const { X, y, train, valid } = xorData(1000);
  const model = trainGbdt(X, y, 3, train, valid, { ...fast, excluded: new Set([0]) });
  assert.ok(model.trees.every((tree) => tree.feature.every((feature) => feature !== 0)));
  assert.equal(model.gain[0], 0);
});

test('the ONNX export gives the same probabilities as the trees', async () => {
  const { X, y, train, valid } = xorData(1500);
  const model = trainGbdt(X, y, 3, train, valid, fast);
  const directory = await mkdtemp(join(tmpdir(), 'itachio-gbdt-'));
  try {
    const path = join(directory, 'gbdt.onnx');
    await exportGbdtOnnx(model, path);
    const names = ['a', 'b', 'noise'];
    const predictor = await DraftPredictor.load(path, names);
    for (const row of [0, 1, 2, 3, 500, 1000]) {
      const features = [X[row * 3]!, X[row * 3 + 1]!, X[row * 3 + 2]!];
      const probability = await predictor.predictWinProbability({ features } as never);
      assert.ok(Math.abs(probability - 1 / (1 + Math.exp(-gbdtLogit(model, X, row)))) < 1e-4);
    }
    await predictor.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Champion 1 top wins 70%, champion 2 top 30%; start times one minute apart
function compactMatches(count: number, flipFrom = Infinity): CompactMatch[] {
  const next = random(11);
  return Array.from({ length: count }, (_, i) => {
    const top = next() > 0.5 ? [1, 2] : [2, 1];
    const blueStrong = top[0] === 1;
    const roll = next() < 0.7;
    const won = blueStrong === roll;
    return {
      id: `EUW1_${i}`, q: 440 as const, patch: '16.21', t: 1_700_000_000_000 + i * 60_000, d: 1900,
      w: ((i >= flipFrom ? !won : won) ? 1 : 0) as 0 | 1,
      b: [top[0]!, 11, 12, 13, 14], r: [top[1]!, 21, 22, 23, 24],
      x: [31, 32, 33, 34],
      xb: [[1000, 4000, 100, 10, 7000], null, null, null, null],
      xr: [[4000, 1000, 100, 2, 3000], null, null, null, null],
    };
  });
}

test('history: bans and real matchup spreads, older matches without numbers leave the profiles alone', () => {
  const withFacts = compactMatches(600).map((row) => compactMatchToRiotMatch(row));
  const bare = compactMatches(600).map(({ xb: _b, xr: _r, ...row }) => compactMatchToRiotMatch({ ...row, id: `${row.id}x` }));
  const history = makeHistory(withFacts);
  const top = history.champions['1:TOP']!;
  assert.equal(top.banRate, 0);
  const mixed = makeHistory([...withFacts, ...bare]).champions['1:TOP']!;
  assert.equal(mixed.cc, top.cc, 'matches without numbers do not dilute the average');
  assert.equal(mixed.frontline, top.frontline);
});

test('history: a hard counter shows in the matchup spread and the counter rate', () => {
  const games: RiotMatchV5[] = [];
  const play = (id: string, blue: number, red: number, blueWon: boolean) => games.push(compactMatchToRiotMatch({ id, q: 440, patch: '16.21', w: blueWon ? 1 : 0, b: [blue, 11, 12, 13, 14], r: [red, 21, 22, 23, 24] }));
  // A ring: 1 beats 2, 2 beats 3, 3 beats 1, all with even records; 4 and 5 trade evenly
  for (let i = 0; i < 300; i++) {
    play(`a${i}`, 1, 2, i % 5 !== 0);
    play(`b${i}`, 2, 3, i % 5 !== 0);
    play(`c${i}`, 3, 1, i % 5 !== 0);
    play(`d${i}`, 4, 5, i % 2 === 0);
  }
  const champions = makeHistory(games).champions;
  assert.ok(champions['1:TOP']!.counterRate > 0.1);
  assert.ok(champions['1:TOP']!.blindSpread > champions['4:TOP']!.blindSpread);
  assert.ok(champions['1:TOP']!.counterChance > champions['1:TOP']!.counterRate);
});

test('compact bans reach the ban rates', () => {
  const rows = compactMatches(100).map((row) => ({ ...row, b: [1, 11, 12, 13, 14], r: [2, 21, 22, 23, 24], x: [1, 32, 33, 34] }));
  const history = makeHistory(rows.map((row) => compactMatchToRiotMatch(row)));
  assert.equal(history.champions['1:TOP']!.banRate, 1);
});

test('the sparse layer finds the strong champion, seen from both sides', () => {
  const matches = compactMatches(1500).map((row) => compactMatchToRiotMatch(row));
  const layer = fitSparseLayer(matches);
  assert.ok(layer.weights['c:1:TOP']! > 0.2);
  assert.ok(layer.weights['c:2:TOP']! < -0.2);
  const sides = indexMatch(matches.find((match) => match.info.participants[0]!.championId === 1)!)!;
  const blueView = sparseFeatures(layer, sides.get('blue')!, sides.get('red')!, 'TOP');
  const redView = sparseFeatures(layer, sides.get('red')!, sides.get('blue')!, 'TOP');
  assert.ok(blueView[0] > 0 && redView[0] < 0);
  assert.ok(blueView[3] > 0 && Math.abs(blueView[3] + redView[3]) < 1e-9);
});

test('hybrid: learns from the windows, masks the placeholders, ignores later results', async () => {
  const rows = compactMatches(1500);
  const options = { priorShare: 0.5, gbdt: { trees: 30, minChildHessian: 20, learningRate: 0.15 } };
  const fitted = trainHybrid(rows.map((row) => compactMatchToRiotMatch(row)), options);
  const masked = new Set(HYBRID_FEATURE_NAMES.flatMap((name, column) => (MASKED_FEATURES.has(name) ? [column] : [])));
  assert.ok(fitted.model.gbdt.trees.every((tree) => tree.feature.every((feature) => !masked.has(feature))));

  const later = compactMatches(1900).slice(1500);
  const flipped = later.map((row) => ({ ...row, w: (row.w ? 0 : 1) as 0 | 1 }));
  const riot = (list: CompactMatch[]) => list.map((row) => compactMatchToRiotMatch(row));
  const predictions = fitted.predict(riot(later));
  assert.deepEqual([...fitted.predict(riot(flipped))], [...predictions], 'a match\'s own result does not move its prediction');
  const labels = new Map(later.map((row) => [row.id, row.w as number]));
  const result = headToHead(labels, predictions, new Map(later.map((row) => [row.id, 0])));
  assert.ok(result.candidateLogLoss < result.productionLogLoss, 'beats a coin flip on later matches');
  assert.ok(result.candidateAccuracy > 0.6);

  const directory = await mkdtemp(join(tmpdir(), 'itachio-hybrid-'));
  try {
    const path = join(directory, 'draft.onnx');
    await saveHybrid(fitted.model, path);
    const predictor = await DraftPredictor.load(path, HYBRID_FEATURE_NAMES);
    const probability = await predictor.predictWinProbability({ features: new Array(HYBRID_FEATURE_NAMES.length).fill(0.5) } as never);
    assert.ok(probability > 0 && probability < 1);
    await predictor.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('head to head: gain is paired and needs two standard errors', () => {
  const labels = new Map(Array.from({ length: 2000 }, (_, i) => [`m${i}`, i % 2]));
  const good = new Map([...labels].map(([id, label]) => [id, label ? 0.4 : -0.4]));
  const coin = new Map([...labels].map(([id]) => [id, 0]));
  assert.equal(headToHead(labels, good, coin).passed, true);
  assert.equal(headToHead(labels, coin, good).passed, false);
  const same = headToHead(labels, coin, coin);
  assert.equal(same.gain, 0);
  assert.equal(same.passed, false);
  assert.throws(() => headToHead(new Map(), good, coin), /No matches/);
});

test('the test window is the newest timed matches; undated matches stay in development', () => {
  const make = (id: string, t?: number): RiotMatchV5 => compactMatchToRiotMatch({ id, q: 440, w: 1, patch: '16.21', b: [1, 2, 3, 4, 5], r: [6, 7, 8, 9, 10], ...(t ? { t } : {}) });
  const { development, test: testWindow } = chronologicalSplit([make('c', 3000), make('old'), make('a', 1000), make('d', 4000), make('b', 2000)], 0.25);
  assert.deepEqual(development.map((match) => match.metadata.matchId), ['old', 'a', 'b', 'c']);
  assert.deepEqual(testWindow.map((match) => match.metadata.matchId), ['d']);
});
