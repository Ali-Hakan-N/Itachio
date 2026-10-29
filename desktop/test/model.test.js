const test = require('node:test');
const assert = require('node:assert/strict');
global.Recommend = require('../src/renderer/recommend');
const { recommend, evaluate, recommendBans, guessRoles, Engine } = require('../src/renderer/model');

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

test('look ahead: easy-to-counter picks score lower while the enemy can still answer', () => {
  // 30 and 31: equally strong tops. 40 is an enemy top that beats 30 hard; 41 is neutral.
  const m = {
    ...model,
    matches: 1000,
    champ: {
      ...model.champ,
      '30:0': [0.1, 500, 1],
      '31:0': [0.1, 500, 1],
      '40:0': [0, 200, 1],
      '41:0': [0, 600, 1],
    },
    vs: [[30, 0, 40, 0, -0.3]],
  };
  const rec = recommend({ model: m, role: 'top' });
  const a = rec.find((x) => x.championId === 30);
  const b = rec.find((x) => x.championId === 31);
  assert.ok(b.score > a.score && a.counterRisk > 0, `${a.score} ${b.score} risk ${a.counterRisk}`);
  // Once the enemy top is locked, 40 can no longer answer it
  const locked = recommend({ model: m, role: 'top', enemies: [{ championId: 41, position: 'top' }] });
  assert.ok(locked.find((x) => x.championId === 30).counterRisk < a.counterRisk);
  // With every enemy role locked nothing is left to answer with
  const all = ['top', 'jungle', 'middle', 'bottom', 'utility'].map((position, i) => ({ championId: [41, 3, 6, 4, 5][i], position }));
  assert.equal(recommend({ model: m, role: 'top', enemies: all }).find((x) => x.championId === 30).counterRisk, 0);
  // Players who counterpick more (higher lambda) make the counter more likely
  const risk = (lambda) => recommend({ model: { ...m, counterpick: { lambda } }, role: 'top' }).find((x) => x.championId === 30).counterRisk;
  assert.ok(risk(20) > risk(0));
  // evaluate gives the same with lookAhead, the plain score without
  const ev = evaluate({ model: m, championId: 30, role: 'top', lookAhead: true });
  assert.equal(ev.score, a.score);
  assert.equal(evaluate({ model: m, championId: 30, role: 'top' }).counterRisk, undefined);
});

test('personal layer: the player\'s own results on a champion move its score', () => {
  const personal = { byKey: { '2:top': { delta: 0.1, games: 40 } }, unplayed: -0.05 };
  const plain = evaluate({ model, championId: 2, role: 'top' });
  const mine = evaluate({ model, championId: 2, role: 'top', personal });
  assert.ok(mine.score > plain.score && mine.personal > 0 && mine.personalGames === 40);
  // A champion the player never played gets the unplayed value
  const other = evaluate({ model, championId: 1, role: 'top', personal });
  assert.ok(other.personal < 0 && other.personalGames === 0);
  // Recommendations rank with it
  const top = (p) => recommend({ model, role: 'top', personal: p }).map((r) => r.championId);
  assert.equal(top(null)[0], 1);
  assert.equal(top({ byKey: { '2:top': { delta: 0.5, games: 80 } }, unplayed: 0 })[0], 2);
});

test('roles: known roles kept, the others guessed from where champions are played', () => {
  const m = { ...model, champ: { ...model.champ, '3:2': [0.1, 900, 0.9], '3:0': [0, 20, 0.02], '4:3': [0, 900, 1], '5:4': [0, 900, 1] } };
  // A first pick mid (3) and a support (5), the rest not picked yet
  const g = guessRoles({ model: m, players: [{ championId: 3 }, { championId: 5 }, {}, {}, {}].map((p) => ({ position: '', championId: 0, ...p })) });
  assert.equal(g.roles[0], 'middle');
  assert.equal(g.roles[1], 'utility');
  assert.deepEqual(g.guessed, [true, true, true, true, true]);
  // A known role is never moved
  const k = guessRoles({ model: m, players: [{ championId: 3, position: 'top' }, ...[0, 0, 0, 0].map(() => ({ championId: 0, position: '' }))] });
  assert.equal(k.roles[0], 'top');
  assert.equal(new Set(k.roles).size, 5);
});

test('relative to a typical pick: board terms that lift every champion do not lift the scores', () => {
  // Every top gets the same synergy with the support: scores stay where they were
  const m = { ...model, matches: 1000, syn: [1, 2, 3].map((c) => [c, 0, 5, 4, 0.2]) };
  const empty = recommend({ model: m, role: 'top' });
  const withSupport = recommend({ model: m, role: 'top', allies: [{ championId: 5, position: 'utility' }] });
  for (const id of [1, 2]) assert.equal(withSupport.find((x) => x.championId === id).score, empty.find((x) => x.championId === id).score);
  // A synergy only one of them has still moves it up
  const one = { ...m, syn: [[2, 0, 5, 4, 0.2]] };
  const two = recommend({ model: one, role: 'top', allies: [{ championId: 5, position: 'utility' }] }).find((x) => x.championId === 2).score;
  assert.ok(two > recommend({ model: one, role: 'top' }).find((x) => x.championId === 2).score);
});
