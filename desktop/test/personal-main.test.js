const test = require('node:test');
const assert = require('node:assert/strict');
global.Recommend = require('../src/renderer/recommend');
const { recommend, evaluate } = require('../src/renderer/model');
const Traits = require('../src/renderer/traits');

// 1, 2 meta tops; 3 is off-meta top (well under 1% of teams); 4 never seen top
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
    '3:0': [-0.05, 40, 0.5],
    '3:2': [0.0, 5000, 0.5],
    '4:2': [0.0, 5000, 1],
  },
  syn: [], vs: [], ts: {}, tv: {},
  tags: { 1: 'Fighter', 2: 'Fighter', 3: 'Mage', 4: 'Mage' },
};
const ids = (rows) => rows.map((r) => r.championId);

test('an off-meta champion is off the list, except for a player who mains it', () => {
  assert.equal(ids(recommend({ model, role: 'top' })).includes(3), false);
  const few = { season: { byKey: { '3:0': { delta: 0.2, games: 5, mastery: 0.9 } }, unplayed: 0 } };
  assert.equal(ids(recommend({ model, role: 'top', personal: few })).includes(3), false);
  const losing = { season: { byKey: { '3:0': { delta: -0.2, games: 60, mastery: 0.9 } }, unplayed: 0 } };
  assert.equal(ids(recommend({ model, role: 'top', personal: losing })).includes(3), false);
  const main = { season: { byKey: { '3:top': { delta: 0.2, games: 60, mastery: 0.9 } }, unplayed: 0 } };
  assert.equal(ids(recommend({ model, role: 'top', personal: { season: { byKey: { '3:0': main.season.byKey['3:top'] }, unplayed: 0 } } })).includes(3), false, 'keys use role names');
  assert.equal(ids(recommend({ model, role: 'top', personal: main })).includes(3), true);
  assert.equal(ids(recommend({ model, role: 'top', personal: { season: { byKey: { '4:top': { delta: 0.2, games: 60, mastery: 1 } }, unplayed: 0 } } })).includes(4), true);
});

test('mastery lets the personal effect of a main go past the normal cap', () => {
  const effect = (mastery, games = 80) => evaluate({
    model, championId: 2, role: 'top',
    personal: { season: { byKey: { '2:top': { delta: 5, games, mastery } }, unplayed: 0 } },
  }).parts.personal;
  assert.ok(effect(1) > effect(0) * 1.9);
  assert.ok(Math.abs(effect(0.5) / effect(0) - 1.5) < 1e-9);
  assert.equal(effect(1, 10), effect(0, 10), 'a few games are not a main');
});

test('measured traits move hand scores, and fully define a champion missing from the table', () => {
  const ahri = Traits.BY_NAME.get('Ahri');
  const hand = Traits.traitsOf(ahri, 'Mage').cc;
  try {
    Traits.useLearnedTraits({ [ahri]: { mg: 0.5, cc: 3, fr: 3, n: 200 }, 99999: { mg: 0.1, cc: 3, n: 2000 } });
    const moved = Traits.traitsOf(ahri, 'Mage');
    assert.ok(Math.abs(moved.cc - (hand + 0.5 * (3 - hand))) < 1e-9);
    assert.ok(moved.mg < 1);
    // A huge sample still leaves part of the hand score
    Traits.useLearnedTraits({ [ahri]: { mg: 0, cc: 3, n: 1e9 } });
    assert.ok(Traits.traitsOf(ahri, 'Mage').cc < 3);
    Traits.useLearnedTraits({ 99999: { mg: 0.1, cc: 3, n: 2000 } });
    assert.ok(Math.abs(Traits.traitsOf(99999, 'Mage').mg - 0.1) < 0.01);
    assert.ok(Traits.traitsOf(99999, 'Mage').cc > 2.9);
  } finally {
    Traits.useLearnedTraits(null);
  }
  assert.equal(Traits.traitsOf(ahri, 'Mage').cc, hand);
});

test('a rare champion uses its class latent vectors; a snapshot without them is unchanged', () => {
  const fm = { k: 1, S: { '1:0': [1] }, P: {}, Q: {}, prior: { S: { 'Fighter:0': [1], 'Mage:2': [2] }, P: {}, Q: {} } };
  const withPrior = { ...model, fm };
  const without = { ...model, fm: { k: 1, S: { '1:0': [1] }, P: {}, Q: {} } };
  const synergy = (m) => evaluate({ model: m, championId: 1, role: 'top', allies: [{ championId: 4, position: 'middle' }] }).parts.synergy;
  assert.ok(synergy(withPrior) > synergy(without));
});
