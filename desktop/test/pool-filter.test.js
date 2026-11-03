const test = require('node:test');
const assert = require('node:assert/strict');
global.Recommend = require('../src/renderer/recommend');
const { recommend, Engine } = require('../src/renderer/model');

// Tops: 1 strong, 2 average, 3 off-meta (under 1% of teams). 4 is only seen mid. 5 is an enemy jungler.
const model = {
  heuristics: false,
  matches: 10000,
  pointsPerLogit: 150,
  center: 0,
  shareFloor: 0.002,
  off: [-0.05, -0.05, -0.05, -0.05, -0.05],
  champ: {
    '1:0': [0.1, 5000, 0.95],
    '2:0': [0.0, 5000, 0.95],
    '3:0': [0.05, 40, 0.5],
    '3:2': [0.0, 5000, 0.5],
    '4:2': [0.0, 5000, 1],
    '5:1': [0.0, 5000, 1],
  },
  syn: [], vs: [], ts: {}, tv: {},
  tags: { 1: 'Fighter', 2: 'Fighter', 3: 'Mage', 4: 'Mage', 5: 'Tank' },
};
const ALL = [1, 2, 3, 4, 5];
const picks = (filter, extra = {}) => {
  const rule = Engine.poolPickable(filter, extra.pickable ?? null, ALL);
  return recommend({ model, role: 'top', pickable: rule.pickable, keep: rule.keep }).map((r) => r.championId);
};

test('off, or an empty list, filters nothing and keeps what the client allows', () => {
  for (const filter of [null, { mode: 'off', champions: [1] }, { mode: 'include', champions: [] }, { mode: 'exclude', champions: [] }, { mode: 'nonsense', champions: [1] }]) {
    const rule = Engine.poolPickable(filter, [1, 2], ALL);
    assert.deepEqual(rule, { pickable: [1, 2], keep: null, active: false });
  }
  assert.deepEqual(picks({ mode: 'off', champions: [2] }), [1, 2]);
});

test('include suggests only the list, within the role', () => {
  assert.deepEqual(picks({ mode: 'include', champions: [2, 5] }), [2]);
  assert.equal(Engine.poolPickable({ mode: 'include', champions: [2] }, null, ALL).active, true);
});

test('include keeps an off-meta champion asked for by name, not one never seen in the role', () => {
  assert.equal(picks({ mode: 'off', champions: [] }).includes(3), false);
  assert.deepEqual(picks({ mode: 'include', champions: [3] }), [3]);
  assert.deepEqual(picks({ mode: 'include', champions: [4] }), []);
});

test('exclude leaves the list out', () => {
  assert.deepEqual(picks({ mode: 'exclude', champions: [1] }), [2]);
  assert.deepEqual(picks({ mode: 'exclude', champions: [1, 2] }), []);
});

test('the client\'s pickable champions still apply', () => {
  assert.deepEqual(Engine.poolPickable({ mode: 'include', champions: [1, 2] }, [2, 3], ALL).pickable, [2]);
  assert.deepEqual(Engine.poolPickable({ mode: 'exclude', champions: [2] }, [2, 3], ALL).pickable, [3]);
  assert.deepEqual(picks({ mode: 'include', champions: [1, 2] }, { pickable: [2] }), [2]);
});

test('an excluded champion is not treated as banned: the scores of the others do not move', () => {
  const plain = recommend({ model, role: 'top' }).find((r) => r.championId === 2);
  const rule = Engine.poolPickable({ mode: 'exclude', champions: [1, 5] }, null, ALL);
  const filtered = recommend({ model, role: 'top', pickable: rule.pickable, keep: rule.keep }).find((r) => r.championId === 2);
  assert.equal(filtered.score, plain.score);
  assert.equal(filtered.logit, plain.logit);
});

test('every role has its own pool: a change in one leaves the others alone', () => {
  const pools = Engine.poolsByRole(null);
  assert.deepEqual(pools.top, { mode: 'off', champions: [] });
  pools.middle.mode = 'exclude';
  pools.middle.champions.push(1);
  assert.deepEqual(pools.top, { mode: 'off', champions: [] });
  assert.deepEqual(pools.utility, { mode: 'off', champions: [] });
  // A champion excluded for mid is still suggested top
  assert.deepEqual(picks(pools.top), [1, 2]);
  const again = Engine.poolsByRole(JSON.parse(JSON.stringify(pools)));
  assert.deepEqual(again.middle, { mode: 'exclude', champions: [1] });
  assert.deepEqual(again.top, { mode: 'off', champions: [] });
});

test('the single list of the older version starts every role, as separate copies', () => {
  const pools = Engine.poolsByRole(null, { mode: 'include', champions: [1, 2] });
  assert.deepEqual(pools.bottom, { mode: 'include', champions: [1, 2] });
  pools.top.champions.push(3);
  assert.deepEqual(pools.middle.champions, [1, 2]);
  // Once saved per role, the old list is ignored
  assert.deepEqual(Engine.poolsByRole({ top: { mode: 'exclude', champions: [4] } }, { mode: 'include', champions: [1] }).middle, { mode: 'off', champions: [] });
});

test('saved pools with broken values fall back to no filter', () => {
  const pools = Engine.poolsByRole({ top: { mode: 'nonsense', champions: ['x', 2] }, jungle: null });
  assert.deepEqual(pools.top, { mode: 'off', champions: [2] });
  assert.deepEqual(pools.jungle, { mode: 'off', champions: [] });
});
