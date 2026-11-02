const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/renderer/model');

const rem = (...positions) => positions.map((position, i) => ({ p: { cellId: i, position }, poolDepth: null }));
const seq = (rounds) => rounds.map(([cellId, ally, round]) => ({ cellId, ally, completed: false, round }));

test('planner: safe roles pick first, solo lanes wait for the enemy to show', () => {
  // slots 0-4 are ours; the enemy picks between ours, so later slots see more of them
  const remaining = rem('top', 'middle', 'bottom', 'jungle', 'utility');
  const sequence = seq([[0, true, 0], [10, false, 1], [11, false, 1], [1, true, 2], [2, true, 2], [12, false, 3], [13, false, 3], [3, true, 4], [4, true, 4], [14, false, 5]]);
  const { order } = Engine.planPickOrder({ remaining, sequence });
  assert.ok(order.indexOf(4) < order.indexOf(0), 'support before top');
  assert.ok(order.indexOf(0) > 0, 'top is not first');
});

test('planner: an opponent already on the board is countered at once', () => {
  const remaining = rem('jungle', 'utility', 'middle');
  const sequence = seq([[0, true, 0], [1, true, 1], [2, true, 2], [10, false, 3]]);
  const { order } = Engine.planPickOrder({ remaining, enemyPicks: [{ championId: 5, position: 'middle' }], sequence });
  assert.equal(order[0], 2, 'mid first, the enemy mid is known');
});

test('planner: a small saving does not reorder, a large one does', () => {
  const remaining = rem('jungle', 'bottom', 'utility');
  const plan = Engine.planPickOrder({ remaining, sequence: [] });
  const shown = [1, 0, 2];
  assert.ok(plan.costOf(shown) - plan.costOf(plan.order) < 4, 'swapping two safe roles is not worth a change');
  const solo = rem('top', 'utility');
  const p2 = Engine.planPickOrder({ remaining: solo, sequence: seq([[0, true, 0], [10, false, 1], [11, false, 2], [1, true, 3]]) });
  assert.ok(p2.costOf([0, 1]) - p2.costOf(p2.order) >= 4, 'top first costs a lot while the enemy is unseen');
  assert.deepEqual(p2.order, [1, 0]);
});
