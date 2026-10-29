const test = require('node:test');
const assert = require('node:assert/strict');
global.Recommend = require('../src/renderer/recommend');
const { recommend, evaluate, Engine } = require('../src/renderer/model');

// Roles: 0 top, 1 jungle, 2 middle, 3 bottom, 4 utility
// 1 strong top, 2 average top, 3 mid that is rarely played top, 4 bot, 5 support, 6 enemy mid
const model = {
  pointsPerLogit: 150,
  center: 0,
  shareFloor: 0.002,
  off: [-0.05, -0.05, -0.05, -0.05, -0.05],
  champ: {
    '1:0': [0.15, 900, 0.95],
    '2:0': [0.0, 900, 0.95],
    '3:2': [0.1, 900, 0.9],
    '3:0': [0.0, 20, 0.02],
    '4:3': [0.0, 900, 1],
    '5:4': [0.0, 900, 1],
    '6:2': [0.0, 900, 1],
  },
  syn: [[4, 3, 5, 4, 0.12]], // 4 bot + 5 support
  vs: [[1, 0, 6, 2, -0.08]], // 1 top is weak against 6 mid
  ts: { 'Mage:Tank': 0.02 },
  tv: { 'Fighter:Mage': 0.03 }, // fighters do a bit better against mages
  tags: { 1: 'Fighter', 2: 'Fighter', 3: 'Mage', 4: 'Marksman', 5: 'Tank', 6: 'Mage' },
};

test('stronger champion scores higher; average champion is 50', () => {
  const r = recommend({ model, role: 'top' });
  assert.equal(r[0].championId, 1);
  assert.ok(r[0].score > 60);
  assert.equal(r.find((x) => x.championId === 2).score, 50);
});

test('off-role comes from the data: a mid played top a few times scores low', () => {
  const top = evaluate({ model, championId: 3, role: 'top' });
  const mid = evaluate({ model, championId: 3, role: 'middle' });
  assert.ok(top.offRole && !mid.offRole);
  assert.ok(top.score < 50 && mid.score > top.score);
});

test('synergy with a bot lane partner raises the score, with the role taken into account', () => {
  const alone = evaluate({ model, championId: 4, role: 'bottom' });
  const withSupport = evaluate({ model, championId: 4, role: 'bottom', allies: [{ championId: 5, position: 'utility' }] });
  assert.ok(withSupport.score > alone.score);
  // the same pair read from the support's side
  const support = evaluate({ model, championId: 5, role: 'utility', allies: [{ championId: 4, position: 'bottom' }] });
  assert.ok(support.score > 50);
});

test('matchups work both ways; enemy role is guessed when unknown', () => {
  const vs = evaluate({ model, championId: 1, role: 'top', enemies: [{ championId: 6 }] });
  assert.ok(vs.score < evaluate({ model, championId: 1, role: 'top' }).score);
  const other = evaluate({ model, championId: 6, role: 'middle', enemies: [{ championId: 1, position: 'top' }] });
  assert.ok(other.score > 50); // 6 is strong against 1
});

test('class pairs give unseen pairs a small effect', () => {
  // no direct weight for 2 top against 3 mid, but Fighter vs Mage has one
  const vs = evaluate({ model, championId: 2, role: 'top', enemies: [{ championId: 3, position: 'middle' }] });
  assert.ok(vs.score > 50 && vs.score < 55);
});

test('the scale is fixed: a champion scores the same no matter what else is listed', () => {
  const a = recommend({ model, role: 'top' }).find((x) => x.championId === 1).score;
  const b = recommend({ model, role: 'top', unavailable: new Set([2, 3]) }).find((x) => x.championId === 1).score;
  assert.equal(a, b);
  assert.ok(a < 100);
});

test('Engine falls back to the older scoring without a model', () => {
  const stats = { meta: [{ champion_id: 9, role: 'top', score: 61 }], synergy: [], matchup: [] };
  const r = Engine.recommend({ stats, model: null, role: 'top', allies: [{ championId: 4, position: 'bottom' }] });
  assert.equal(r[0].championId, 9);
  assert.equal(r[0].score, 61);
});

test('latent pairs add synergy and antisymmetric matchups', () => {
  const m = {
    ...model,
    fm: {
      k: 2,
      S: { '4:3': [0.3, 0], '5:4': [0.3, 0] }, // <S4, S5> = 0.09
      P: { '1:0': [0.2, 0], '6:2': [0, 0] },
      Q: { '1:0': [0, 0], '6:2': [0.25, 0] }, // 1 against 6: 0.05; 6 against 1: -0.05
    },
  };
  const bot = evaluate({ model: m, championId: 4, role: 'bottom', allies: [{ championId: 5, position: 'utility' }] });
  const botNoFm = evaluate({ model, championId: 4, role: 'bottom', allies: [{ championId: 5, position: 'utility' }] });
  assert.ok(bot.score > botNoFm.score);
  const a = evaluate({ model: m, championId: 1, role: 'top', enemies: [{ championId: 6, position: 'middle' }] });
  const b = evaluate({ model, championId: 1, role: 'top', enemies: [{ championId: 6, position: 'middle' }] });
  assert.ok(a.score > b.score);
  const c = evaluate({ model: m, championId: 6, role: 'middle', enemies: [{ championId: 1, position: 'top' }] });
  const d = evaluate({ model, championId: 6, role: 'middle', enemies: [{ championId: 1, position: 'top' }] });
  assert.ok(c.score < d.score);
});

test('picks resting on little data are marked unsure', () => {
  const m = { ...model, champ: { ...model.champ, '2:0': [0.0, 25, 0.95, 0.2] } };
  assert.equal(evaluate({ model: m, championId: 2, role: 'top' }).unsure, true);
  const sure = { ...model, champ: { ...model.champ, '2:0': [0.0, 900, 0.95, 0.01] } };
  assert.equal(evaluate({ model: sure, championId: 2, role: 'top' }).unsure, false);
});

test('an over-stretched scale is capped', () => {
  const wild = { ...model, pointsPerLogit: 600 };
  assert.ok(evaluate({ model: wild, championId: 1, role: 'top' }).score === evaluate({ model: { ...model, pointsPerLogit: 187.5 }, championId: 1, role: 'top' }).score);
});
