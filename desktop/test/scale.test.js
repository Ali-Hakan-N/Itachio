const test = require('node:test');
const assert = require('node:assert/strict');
global.Recommend = require('../src/renderer/recommend');
const { recommend, evaluate, SCALE } = require('../src/renderer/model');

// The numbers the comments of model.js and docs/DRAFT_MODEL.md promise, from the constants
const points = (sds) => 50 * Math.tanh(SCALE.SPREAD * sds);

test('scale: one, two and three standard deviations of strength score 67, 80 and 89', () => {
  assert.equal(Math.round(50 + points(1)), 67);
  assert.equal(Math.round(50 + points(2)), 80);
  assert.equal(Math.round(50 + points(3)), 89);
});

test('scale: the personal effect is about 10 points at most, a main\'s about 15', () => {
  const normal = points(SCALE.PERSONAL_CAP);
  const main = points(SCALE.PERSONAL_CAP * (1 + SCALE.MAIN_CAP_GAIN));
  assert.ok(normal >= 9 && normal <= 11, `normal ${normal}`);
  assert.ok(main >= 14 && main <= 16, `main ${main}`);
  // Never more than a standard deviation of champion strength
  assert.ok(SCALE.PERSONAL_CAP * (1 + SCALE.MAIN_CAP_GAIN) <= 1);
});

test('scale: a ban one standard deviation above average, picked one game in ten, scores 63', () => {
  const value = 0.1 * 1; // P(pick) × standard deviations above the role's average pick
  assert.equal(Math.round(100 * (1 - Math.exp(-value / SCALE.BAN_UNIT))), 63);
});

// Tops 1-4 a little stronger than 5-8; 9 and 10 (jungle) only widen the scale
const top = (w) => [w, 5000, 0.9];
const model = {
  heuristics: false,
  matches: 10000,
  shareFloor: 0.002,
  off: [0, 0, 0, 0, 0],
  champ: {
    '1:0': top(0.05), '2:0': top(0.049), '3:0': top(0.048), '4:0': top(0.047),
    '5:0': top(0.046), '6:0': top(0.045), '7:0': top(0.044), '8:0': top(0.043), '11:0': top(0.042),
    '9:1': [0.3, 5000, 1], '10:1': [-0.3, 5000, 1],
  },
  syn: [], vs: [], ts: {}, tv: {},
  tags: {},
};
// Four champions outside the draft's first five, lifted by comfort
const comfy = { season: { byKey: Object.fromEntries([6, 7, 8, 11].map((id) => [`${id}:top`, { delta: 1, games: 100 }])), unplayed: 0 } };

test('diversity: at most three of the first five are there only by comfort', () => {
  const rows = recommend({ model, role: 'top', personal: comfy });
  const first = rows.slice(0, SCALE.COMFORT_TOP);
  assert.equal(first.filter((r) => r.comfortLifted).length, SCALE.COMFORT_SLOTS);
  assert.ok(first.some((r) => r.championId === 1), 'the draft\'s own best stays in the top');
  // The one that waits comes right after, and no score changes
  assert.equal(rows[SCALE.COMFORT_TOP].comfortLifted, true);
  const waiting = rows[SCALE.COMFORT_TOP];
  assert.equal(waiting.score, evaluate({ model, championId: waiting.championId, role: 'top', personal: comfy }).score);
});

test('diversity: without comfort the order is the draft\'s', () => {
  const rows = recommend({ model, role: 'top' });
  assert.deepEqual(rows.slice(0, 8).map((r) => r.championId), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(rows.every((r) => !r.comfortLifted));
});
