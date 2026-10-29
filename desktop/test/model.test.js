const test = require('node:test');
const assert = require('node:assert/strict');
global.Recommend = require('../src/renderer/recommend');
const { recommend, evaluate, recommendBans, Engine } = require('../src/renderer/model');

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

test('stronger champion scores higher, on a scale stretched to the model spread', () => {
  const r = recommend({ model, role: 'top' });
  assert.equal(r[0].championId, 1);
  assert.ok(r[0].score > 65, `top score ${r[0].score}`);
  assert.ok(r.find((x) => x.championId === 2).score < r[0].score);
});

test('tiny learned effects still spread over the scale', () => {
  const shrink = (m, f) => ({ ...m, off: m.off.map((x) => x * f), champ: Object.fromEntries(Object.entries(m.champ).map(([k, v]) => [k, [v[0] * f, ...v.slice(1)]])) });
  const a = recommend({ model, role: 'top' }).map((x) => x.score);
  const b = recommend({ model: shrink(model, 0.1), role: 'top' }).map((x) => x.score);
  assert.deepEqual(a, b);
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

test('early game pairs add to the learned pairs, in any roles', () => {
  const ctx = { championId: 1, role: 'top', enemies: [{ championId: 6, position: 'middle' }] };
  const plain = evaluate({ model, ...ctx }).score;
  // 1 top is weak against 6 mid (-0.08); the early game says a bit less so (+0.03)
  const both = evaluate({ model: { ...model, vsE: [[1, 0, 6, 2, 0.03]] }, ...ctx }).score;
  assert.ok(both > plain);
  // Seen from the other side it flips
  const other = { championId: 6, role: 'middle', enemies: [{ championId: 1, position: 'top' }] };
  assert.ok(evaluate({ model: { ...model, vsE: [[1, 0, 6, 2, 0.03]] }, ...other }).score < evaluate({ model, ...other }).score);
  // Not only lane opponents: a top laner against the enemy jungler counts too
  const jungle = { ...model, champ: { ...model.champ, '7:1': [0, 900, 1] } };
  const vsJungle = (m) => evaluate({ model: m, championId: 2, role: 'top', enemies: [{ championId: 7, position: 'jungle' }] }).score;
  assert.ok(vsJungle({ ...jungle, vsE: [[2, 0, 7, 1, 0.05]] }) > vsJungle(jungle));
  // Synergy too
  const syn = (m) => evaluate({ model: m, championId: 2, role: 'top', allies: [{ championId: 5, position: 'utility' }] }).score;
  assert.ok(syn({ ...model, synE: [[2, 0, 5, 4, 0.05]] }) > syn(model));
});

test('picks with few games in the role are marked unsure', () => {
  const m = { ...model, champ: { ...model.champ, '2:0': [0.0, 25, 0.95, 0.2] } };
  assert.equal(evaluate({ model: m, championId: 2, role: 'top' }).unsure, true);
  assert.equal(evaluate({ model, championId: 2, role: 'top' }).unsure, false);
});

test('bans: strong, often picked champions first; counters to our picks rise; open roles only', () => {
  const m = {
    ...model,
    matches: 1000,
    champ: {
      ...model.champ,
      '7:0': [0.2, 300, 1], // strong top, picked 15% of games
      '8:0': [0.2, 20, 1], // just as strong, rarely picked
      '9:2': [0.05, 400, 1], // a bit above average mid, counters our 1 top
      '10:4': [0.3, 900, 1], // very strong support, often banned
    },
    vs: [...model.vs, [1, 0, 9, 2, -0.3]],
    banRate: { 10: 0.5 },
  };
  const bans = recommendBans({ model: m });
  const at = (id) => bans.findIndex((b) => b.championId === id);
  assert.ok(at(7) >= 0 && at(7) < at(8), 'often picked before rarely picked');
  assert.equal(bans[0].championId, 10, 'ban rate raises the chance it is picked when open');
  assert.ok(bans.every((b) => b.score >= 0 && b.score <= 100));
  // 9 mid counters our top 1: worth more once we intend to play 1
  const plain = recommendBans({ model: m }).find((b) => b.championId === 9)?.value || 0;
  const vsUs = recommendBans({ model: m, allies: [{ championId: 1, position: 'top' }] }).find((b) => b.championId === 9).value;
  assert.ok(vsUs > plain);
  // Our own pick intents are never suggested; a role the enemy already filled is skipped
  assert.ok(!recommendBans({ model: m, allies: [{ championId: 7, position: 'top' }] }).some((b) => b.championId === 7));
  assert.ok(!recommendBans({ model: m, enemies: [{ championId: 2, position: 'top' }] }).some((b) => b.championId === 7));
  // Unavailable (banned or locked) champions are left out
  assert.ok(!recommendBans({ model: m, unavailable: new Set([10]) }).some((b) => b.championId === 10));
  assert.deepEqual(Engine.recommendBans({ model: null }), []);
});
