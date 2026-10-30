const test = require('node:test');
const assert = require('node:assert/strict');
global.Recommend = require('../src/renderer/recommend');
const { recommend, evaluate, recommendBans, guessRoles, gamePlan, winChance, winParts, Engine } = require('../src/renderer/model');

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

test('unknown flex roles use the role-share distribution for matchup score', () => {
  const flexModel = {
    ...model,
    champ: { ...model.champ, '6:0': [0, 900, 0.5], '6:2': [0, 900, 0.5] },
    vs: [[1, 0, 6, 0, 0.12], [1, 0, 6, 2, -0.12]],
  };
  const top = evaluate({ model: flexModel, championId: 1, role: 'top', enemies: [{ championId: 6, position: 'top' }] });
  const mid = evaluate({ model: flexModel, championId: 1, role: 'top', enemies: [{ championId: 6, position: 'middle' }] });
  const flex = evaluate({ model: flexModel, championId: 1, role: 'top', enemies: [{ championId: 6 }] });

  assert.ok(flex.matchup < top.matchup);
  assert.ok(flex.matchup > mid.matchup);
});

test('team synergy nudges a flex champion toward compatible roles without fixing the role', () => {
  const flexModel = {
    ...model,
    champ: { ...model.champ, '70:0': [0, 100, 0.2], '70:2': [0, 400, 0.8], '71:1': [0, 300, 1] },
  };
  const picks = [{ championId: 70 }, { championId: 71, position: 'jungle' }];
  const plain = Engine.roleDistribution({ model: flexModel, picks })[0].roles;
  const synergy = Engine.roleDistribution({ model: { ...flexModel, syn: [[70, 0, 71, 1, 1]] }, picks })[0].roles;

  assert.ok(synergy.top > plain.top);
  assert.ok(synergy.middle > 0);
  assert.ok(synergy.top < 1);
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
  const personal = { history: { byKey: { '2:top': { delta: 0.1, games: 40 } }, unplayed: -0.05 } };
  const plain = evaluate({ model, championId: 2, role: 'top' });
  const mine = evaluate({ model, championId: 2, role: 'top', personal });
  assert.ok(mine.score > plain.score && mine.personal > 0 && mine.personalGames === 40);
  // A champion the player never played gets the unplayed value
  const other = evaluate({ model, championId: 1, role: 'top', personal });
  assert.ok(other.personal < 0 && other.personalGames === 0);
  // Recommendations rank with it
  const top = (p) => recommend({ model, role: 'top', personal: p }).map((r) => r.championId);
  assert.equal(top(null)[0], 1);
  // Capped: even a huge value moves a score by a few points only
  const capped = evaluate({ model, championId: 2, role: 'top', personal: { history: { byKey: { '2:top': { delta: 5, games: 80 } }, unplayed: 0 } } });
  assert.ok(capped.personal > 0 && capped.personal <= 8, `capped ${capped.personal}`);
  // Both sources add up (before the cap)
  const both = evaluate({ model, championId: 2, role: 'top', personal: { history: personal.history, team: personal.history } });
  assert.ok(both.personal >= mine.personal);
  assert.equal(top(null)[0], 1);
});

test('unseen champions inherit a shrinkage-weighted class and role comfort prior', () => {
  const personal = Engine.personalFor({
    player: {
      season: {
        unplayed: 0,
        byKey: {
          '100:top': { delta: 0.2, games: 20 },
          '101:top': { delta: 0.1, games: 20 },
        },
      },
    },
  }, 'player', [], () => 'Fighter');

  assert.ok(Math.abs(personal.season.byClass['Fighter:top'].delta - 0.075) < 1e-12);
  const score = evaluate({ model, championId: 2, role: 'top', personal });
  assert.ok(score.personal > 0);
  assert.equal(score.personalGames, 40);
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
  // Another popular support makes 5 an open question until it is picked
  const one = { ...m, champ: { ...m.champ, '7:4': [0, 2000, 1] }, syn: [[2, 0, 5, 4, 0.2]] };
  const two = recommend({ model: one, role: 'top', allies: [{ championId: 5, position: 'utility' }] }).find((x) => x.championId === 2).score;
  assert.ok(two > recommend({ model: one, role: 'top' }).find((x) => x.championId === 2).score);
});

test('rest of the draft: synergy with the support we are likely to pick counts before it is picked', () => {
  // Supports: 5 is picked far more often than 7. Top 1 goes with 5, top 2 with 7, equally well.
  const m = {
    ...model, matches: 1000,
    champ: { ...model.champ, '1:0': [0.05, 900, 0.95], '2:0': [0.05, 900, 0.95], '5:4': [0, 1500, 1], '7:4': [0, 100, 1] },
    syn: [[1, 0, 5, 4, 0.2], [2, 0, 7, 4, 0.2]],
  };
  const rec = recommend({ model: m, role: 'top' });
  assert.ok(rec.find((x) => x.championId === 1).score > rec.find((x) => x.championId === 2).score);
  // Once the support is locked, only the real one counts
  const after = recommend({ model: m, role: 'top', allies: [{ championId: 7, position: 'utility' }] });
  assert.ok(after.find((x) => x.championId === 2).score > after.find((x) => x.championId === 1).score);
});

test('composition: a champion that gives the team the style it lacks scores higher', () => {
  // One style: having some of it is worth a lot, more of it little (tanh). 1 and 2 are equal tops; 1 has the style.
  const comp = { k: 1, a: [0.3], c: [0], m: [], U: { 1: [1.5], 2: [0], 4: [1.5], 5: [0] } };
  const m = { ...model, comp, champ: { ...model.champ, '1:0': [0.05, 900, 0.95], '2:0': [0.05, 900, 0.95] } };
  const top = (allies) => Object.fromEntries(recommend({ model: m, role: 'top', allies }).map((x) => [x.championId, x.score]));
  const none = top([{ championId: 5, position: 'utility' }]); // the team has none of it yet
  const has = top([{ championId: 4, position: 'bottom' }]); // the bot laner already brings it
  assert.ok(none[1] - none[2] > has[1] - has[2], `${none[1] - none[2]} > ${has[1] - has[2]}`);
});

test('learned composition pillars affect draft win parts by team class proxies', () => {
  const withPillars = { ...model, pillars: { damageImbalance: 0, frontline: 1, control: 0 } };
  const args = {
    model: withPillars,
    allies: [
      { championId: 1, position: 'top' }, { championId: 2, position: 'jungle' },
      { championId: 3, position: 'middle' }, { championId: 4, position: 'bottom' }, { championId: 5, position: 'utility' },
    ],
    enemies: [
      { championId: 6, position: 'top' }, { championId: 3, position: 'jungle' },
      { championId: 6, position: 'middle' }, { championId: 4, position: 'bottom' }, { championId: 5, position: 'utility' },
    ],
  };
  const parts = winParts(args);
  const withoutPillars = winParts({ ...args, model });

  assert.ok(parts.composition > withoutPillars.composition);
});

test('uncertain strength counts less: a rare pick scores below an equally strong common one', () => {
  // Same estimated strength; 8 rests on few games (large standard error), 1 on many
  const m = {
    ...model, matches: 10000,
    champ: { ...model.champ, '1:0': [0.15, 900, 0.95, 0.02], '2:0': [0, 900, 0.95, 0.02], '8:0': [0.15, 30, 0.9, 0.15] },
  };
  const score = (id, mm = m) => evaluate({ model: mm, championId: id, role: 'top' }).score;
  assert.ok(score(8) < score(1), `${score(8)} < ${score(1)}`);
  // The penalty fades as the error shrinks
  const surer = { ...m, champ: { ...m.champ, '8:0': [0.15, 300, 0.9, 0.05] } };
  assert.ok(score(8, surer) > score(8));
});

test('off-meta picks (picked by under 1% of teams in the role) are not recommended, but still scored', () => {
  const m = { ...model, matches: 10000, champ: { ...model.champ, '8:0': [0.5, 150, 0.9, 0.02] } };
  assert.ok(!recommend({ model: m, role: 'top', limit: 20 }).some((x) => x.championId === 8));
  assert.ok(evaluate({ model: m, championId: 8, role: 'top' }).score > 0);
});

test('game plan: lanes from the early game model, win chance from the whole draft', () => {
  const laneMean = { '1:0': 0.3, '2:0': -0.3, '4:3': 0, '5:4': 0, '6:2': 0, '3:2': 0 };
  const m = { ...model, early: { laneMean } };
  const allies = [{ championId: 1, position: 'top' }, { championId: 3, position: 'middle' }, { championId: 4, position: 'bottom' }];
  const enemies = [{ championId: 2, position: 'top' }, { championId: 6, position: 'middle' }, { championId: 5, position: 'bottom' }];
  const plan = gamePlan({ model: m, allies, enemies, damage: { magic: { 1: 0, 3: 1, 4: 0, 2: 1, 6: 1, 5: 0 } } });
  assert.equal(plan.lanes[0].call, 'ahead');
  assert.equal(plan.focus, 'top');
  assert.ok(plan.early > 0);
  assert.ok(plan.winChance > 0.5); // 1 top is the strongest champion
  // The parts add up to the win chance, and early plus later is the whole edge
  const parts = Object.values(plan.parts);
  assert.equal(parts.length, 4);
  const logit = (q) => Math.log((50 + q) / (50 - q));
  assert.ok(Math.abs(logit(plan.early) + logit(plan.later) - Math.log(plan.winChance / (1 - plan.winChance))) < 1e-9);
  assert.ok(Math.abs(plan.damage.theirs - 2 / 3) < 1e-9);
  // Seen from the other side the chance flips
  assert.ok(Math.abs(winChance({ model: m, allies: enemies, enemies: allies }) - (1 - plan.winChance)) < 1e-9);
  assert.equal(gamePlan({ model, allies, enemies }), null); // no early game model
  // A learned lane matchup replaces the two average lanes: 1 top loses this one
  const learned = gamePlan({ model: { ...m, early: { laneMean, laneVs: [[0, 1, 2, -0.4, 60]], objMean: { '1:0': 0.05 } } }, allies, enemies });
  assert.equal(learned.lanes[0].call, 'behind');
  assert.equal(learned.lanes[0].games, 60);
  assert.equal(learned.weak, 'top');
  assert.ok(learned.objectives > 0);
});

test('personal layer for a draft: season and patch always, team only with the same line-up', () => {
  const { personalFor } = require('../src/renderer/model');
  const st = { season: { byKey: {} }, history: { byKey: {} }, team: { 'a,b': { byKey: { x: 1 } }, 'a,b,c': { byKey: { x: 2 } } } };
  const stats = { a: st };
  assert.equal(personalFor(stats, 'a', ['b', 'a', null]).team, st.team['a,b']);
  assert.equal(personalFor(stats, 'a', ['c', 'b']).team, st.team['a,b,c']);
  assert.equal(personalFor(stats, 'a', []).team, undefined);
  assert.equal(personalFor(stats, 'a', ['b', 'd']).team, undefined);
  assert.equal(personalFor(stats, 'a').season, st.season);
  assert.equal(personalFor(stats, 'z'), null);
});

test('hybrid ensemble blends model score and external stats layer with confidence weighting', () => {
  const stats = {
    meta: [
      { champion_id: 1, role: 'top', score: 80, source: 'metasrc' },
      { champion_id: 2, role: 'top', score: 40, source: 'metasrc' },
    ],
    synergy: [],
    matchup: [],
  };

  // 1. Fully proven model (high matches, proven syn & vs): caps at 50% model, 50% MetaSRC
  const provenModel = {
    ...model,
    matches: 25000,
    syn: Array(300).fill([1, 0, 2, 0, 0.1]),
    vs: Array(300).fill([1, 0, 2, 0, 0.1]),
  };
  const evProven = Engine.evaluate({ stats, model: provenModel, championId: 1, role: 'top' });
  assert.ok(evProven);
  assert.equal(evProven.weights.model, 0.5);
  assert.equal(evProven.weights.metasrc, 0.5);
  assert.equal(evProven.score, Math.round(0.5 * evProven.modelScore + 0.5 * evProven.metaSrcScore));

  const tunedModel = {
    ...provenModel,
    ensemble: {
      supported: true,
      modelWeight: 0.25,
      metaCalibration: { mean: [0, 0, 0], sd: [1, 1, 1], weights: [0, 1, 0, 0] },
    },
  };
  const baseTuned = evaluate({ model: tunedModel, championId: 1, role: 'top' });
  const evTuned = Engine.evaluate({ stats, model: tunedModel, championId: 1, role: 'top' });
  assert.equal(evTuned.weights.model, 0.25);
  assert.equal(evTuned.weights.metasrc, 0.75);
  assert.equal(evTuned.score, Math.round(100 / (1 + Math.exp(-(0.25 * baseTuned.logit + 0.75)))));

  // 2. Young model without proven syn/vs: model weight is lower, MetaSRC carries the weight
  const youngModel = { ...model, matches: 2000, syn: [], vs: [] };
  const evYoung = Engine.evaluate({ stats, model: youngModel, championId: 1, role: 'top' });
  assert.ok(evYoung);
  assert.ok(evYoung.weights.model < 0.2);
  assert.ok(evYoung.weights.metasrc > 0.8);
  assert.equal(evYoung.score, Math.round(evYoung.weights.model * evYoung.modelScore + evYoung.weights.metasrc * evYoung.metaSrcScore));
});

test('pick order delays top and mid when counter risk is tied, but respects a strong counter risk', () => {
  const picks = [
    { p: { position: 'top' }, risk: 0, matchup: 0 },
    { p: { position: 'middle' }, risk: 0, matchup: 0 },
    { p: { position: 'bottom' }, risk: 0, matchup: 0 },
    { p: { position: 'utility' }, risk: 0, matchup: 0 },
    { p: { position: 'jungle' }, risk: 0, matchup: 0 },
  ];
  assert.deepEqual(Engine.orderPickSuggestions(picks).map((x) => x.p.position), ['utility', 'jungle', 'bottom', 'middle', 'top']);

  const riskyBlindPick = picks.map((x) => x.p.position === 'utility' ? { ...x, risk: 12 } : x);
  const withRisk = Engine.orderPickSuggestions(riskyBlindPick).map((x) => x.p.position);
  assert.ok(withRisk.indexOf('top') < withRisk.indexOf('utility'));
});

test('pick order saves solo lanes until the opponent reveals that lane, then favors the counterpick', () => {
  const picks = [
    { p: { position: 'top' }, risk: 0, matchup: 4 },
    { p: { position: 'middle' }, risk: 0, matchup: 0 },
    { p: { position: 'bottom' }, risk: 0, matchup: 0 },
    { p: { position: 'utility' }, risk: 0, matchup: 0 },
    { p: { position: 'jungle' }, risk: 0, matchup: 0 },
  ];
  const enemyPicks = [{ championId: 6, position: 'top' }];

  assert.equal(Engine.orderPickSuggestions(picks, enemyPicks, model)[0].p.position, 'top');
});

test('pick order does not suggest a trade between simultaneous picks', () => {
  const rated = [
    { p: { cellId: 2, position: 'top' }, risk: 5 },
    { p: { cellId: 3, position: 'utility' }, risk: -2 },
  ];
  const suggested = [rated[1], rated[0]];

  assert.deepEqual(Engine.pickOrderTrades(rated, suggested, [[2, 3]]), []);
});

test('pick order waits for a new ordering to remain stable before applying it', () => {
  const first = Engine.stabilizePickOrder(null, null, [2, 3, 4], 0);
  assert.deepEqual(first, { order: [2, 3, 4], pending: null });

  const change = Engine.stabilizePickOrder(first.order, null, [3, 2, 4], 100);
  assert.deepEqual(change.order, [2, 3, 4]);
  assert.deepEqual(change.pending, { order: [3, 2, 4], since: 100 });
  assert.deepEqual(Engine.stabilizePickOrder(change.order, change.pending, [3, 2, 4], 1400), change);
  assert.deepEqual(Engine.stabilizePickOrder(change.order, change.pending, [3, 2, 4], 1600), {
    order: [3, 2, 4], pending: null,
  });
  assert.deepEqual(Engine.stabilizePickOrder(change.order, change.pending, [2, 3, 4], 500), {
    order: [2, 3, 4], pending: null,
  });
});

test('pick-order hysteresis ignores small priority changes and waits for meaningful ones', () => {
  const current = [
    { p: { cellId: 1 }, orderPriority: 0 },
    { p: { cellId: 2 }, orderPriority: 5 },
  ];
  const desired = [
    { p: { cellId: 2 }, orderPriority: 0 },
    { p: { cellId: 1 }, orderPriority: 2 },
  ];
  const improvement = Engine.pickOrderImprovement([1, 2], [2, 1], desired);
  assert.equal(improvement, 2);
  assert.deepEqual(Engine.stabilizePickOrder([1, 2], null, [2, 1], 100, 1500, true, improvement, 2.5), {
    order: [1, 2], pending: null,
  });
  assert.equal(Engine.pickOrderImprovement([1, 2], [2, 1], [
    { p: { cellId: 2 }, orderPriority: 0 },
    { p: { cellId: 1 }, orderPriority: 3 },
  ]), 3);
});

test('personal player performance increases pick protection priority', () => {
  const picks = [
    { p: { position: 'middle' }, risk: 0, matchup: 0, personal: 0 },
    { p: { position: 'jungle' }, risk: 0, matchup: 0, personal: 0 },
  ];
  const plain = Engine.orderPickSuggestions(picks);
  const personal = Engine.orderPickSuggestions(picks.map((pick) => pick.p.position === 'middle' ? { ...pick, personal: 6 } : pick));

  assert.equal(personal.find((pick) => pick.p.position === 'middle').orderPriority, plain.find((pick) => pick.p.position === 'middle').orderPriority + 3);
});

test('pick order updates at enemy picks and teammate hover changes, not on local hover alone', () => {
  assert.equal(Engine.shouldUpdatePickOrder(false, { side: 'ally', kind: 'pick' }), false);
  assert.equal(Engine.shouldUpdatePickOrder(false, { side: 'ally', kind: 'ban' }), true);
  assert.equal(Engine.shouldUpdatePickOrder(false, null), true);
  assert.equal(Engine.shouldUpdatePickOrder(true, { side: 'ally', kind: 'pick' }), false);
  assert.equal(Engine.shouldUpdatePickOrder(true, { side: 'enemy', kind: 'pick' }), true);
  assert.equal(Engine.shouldUpdatePickOrder(true, { side: 'enemy', kind: 'ban' }), false);
  assert.equal(Engine.shouldUpdatePickOrder(true, null), false);
  assert.equal(Engine.shouldUpdatePickOrderForHover({ side: 'ally', kind: 'pick' }, true), true);
  assert.equal(Engine.shouldUpdatePickOrderForHover({ side: 'ally', kind: 'pick' }, false), false);
  assert.equal(Engine.shouldUpdatePickOrderForHover({ side: 'enemy', kind: 'pick' }, true), false);

  const frozen = Engine.stabilizePickOrder([1, 2], { order: [2, 1], since: 100 }, [2, 1], 500, 1500, false);
  assert.deepEqual(frozen, { order: [1, 2], pending: null });
  assert.deepEqual(Engine.stabilizePickOrder(null, null, [2, 1], 500, 1500, false), { order: [], pending: null });
});
