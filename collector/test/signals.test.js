const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMatch } = require('../src/riot/parse');
const { toCompact } = require('../src/model/features');
const { earlyState, DIM } = require('../src/model/early');
const { recencyWeights, selectRecency, design } = require('../src/model/train');
const { traitProfiles, MIN_GAMES } = require('../src/model/traits');
const { matchLogit } = require('../src/model/predict');
const { analyzePlayers } = require('../src/players/analyze');

const DAY = 86_400_000;

test('recency weights halve per half-life, and a match without a time counts as the oldest', () => {
  const now = 100 * DAY;
  const w = recencyWeights([{ t: now }, { t: now - 7 * DAY }, { t: now - 14 * DAY }, {}], 7, now);
  assert.equal(w[0], 1);
  assert.equal(w[1], 0.5);
  assert.equal(w[2], 0.25);
  assert.equal(w[3], 0.25);
  assert.equal(recencyWeights([{}, {}], 7, now), null);
});

test('no half-life is tried without enough start times', () => {
  const m = { b: [1, 2, 3, 4, 5], r: [6, 7, 8, 9, 10], id: 'X', w: 1 };
  const ctx = { share: new Map(), tagOf: () => 'None' };
  const matches = [m, { ...m, id: 'Y', w: 0, t: DAY }];
  assert.equal(selectRecency(design(matches, ctx), matches, { groups: new Set(['c']), tau: { c: 1 } }, { maxTuneRows: 10, tuneIters: 1 }, () => {}), null);
});

test('a decay is only chosen when the newest matches prove it', () => {
  // The meta flips over time: champion 1 wins on old matches and loses on new ones
  const matches = [];
  const start = 1000 * DAY;
  const mk = (i, oneWins) => ({ id: `X_${i}`, t: start + (i / 6000) * 20 * DAY, b: [1, 2, 3, 4, 5], r: [6, 7, 8, 9, 10], w: (i % 10 < 7) === oneWins ? 1 : 0 });
  for (let i = 0; i < 6000; i++) matches.push(mk(i, i < 4200));
  const ctx = { share: new Map(), tagOf: () => 'None' };
  const D = design(matches, ctx);
  const cfg = { groups: new Set(['c', 'o']), tau: { c: 10, o: 1 }, adaptive: new Set() };
  const r = selectRecency(D, matches, cfg, { maxTuneRows: 6000, tuneIters: 60 }, () => {});
  assert.equal(r.tried.length, 4);
  assert.ok(r.halfLifeDays !== null, 'shifted meta should prefer a half-life');

  // Without a change in the meta nothing is proven
  const steady = Array.from({ length: 6000 }, (_, i) => mk(i, true));
  const flat = selectRecency(design(steady, ctx), steady, cfg, { maxTuneRows: 6000, tuneIters: 60 }, () => {});
  assert.equal(flat.halfLifeDays, null);
});

test('void grubs reach the early state; older matches have 0 there', () => {
  const participants = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'].flatMap((teamPosition, i) => [100, 200].map((teamId) => ({
    championId: teamId + i, teamPosition, teamId, win: teamId === 100, participantId: i + 1,
  })));
  const teams = [
    { teamId: 100, objectives: { horde: { first: true, kills: 5 } } },
    { teamId: 200, objectives: { horde: { first: false, kills: 1 } } },
  ];
  const parsed = parseMatch({ metadata: { matchId: 'EUW1_1' }, info: { queueId: 420, gameDuration: 1800, gameVersion: '16.21.1', participants, teams } });
  assert.deepEqual(parsed.grubs, [5, 1]);
  const compact = toCompact(parsed);
  assert.deepEqual(compact.g, [5, 1]);

  const lane = [0, 0, 0, 0, 0, 0, 0];
  const base = { lb: Array(5).fill(lane), lr: Array(5).fill(lane), f: [0, 0, 0, 0, 1] };
  const s = earlyState({ ...base, g: [5, 1] });
  assert.equal(s.length, DIM);
  assert.ok(Math.abs(s[DIM - 1] - 4 / 3) < 1e-9);
  assert.equal(s[DIM - 2], 1);
  assert.equal(earlyState(base)[DIM - 1], 0);
});

test('measured traits: magic share, ranks on the 0-3 scale, damage taken only when recorded', () => {
  const games = (n, blue, red, xb, xr) => Array.from({ length: n }, () => ({
    b: blue, r: red, d: 1800,
    xb: blue.map((_, i) => (i === 0 ? xb : null)),
    xr: red.map((_, i) => (i === 0 ? xr : null)),
  }));
  const matches = games(MIN_GAMES, [1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [9000, 1000, 0, 60, 30000], [0, 8000, 0, 5, 5000]);
  const p = traitProfiles(matches);
  assert.equal(p[1].mg, 0.9);
  assert.equal(p[6].mg, 0);
  assert.equal(p[1].cc, 3);
  assert.equal(p[6].cc, 0);
  assert.equal(p[1].fr, 3);
  assert.equal(p[1].n, MIN_GAMES);
  assert.equal(p[2], undefined);

  const noTaken = traitProfiles(games(MIN_GAMES, [1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [1, 1, 0, 1], [1, 1, 0, 1]));
  assert.equal('fr' in noTaken[1], false);
  assert.deepEqual(traitProfiles(games(MIN_GAMES - 1, [1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [1, 1, 0, 1], [1, 1, 0, 1])), {});
});

test('a rare champion gets the latent vectors of its class, an old snapshot none', () => {
  const data = {
    bias: 0, champ: {}, off: [0, 0, 0, 0, 0], tags: { 1: 'Mage', 2: 'Tank' },
    fm: { k: 1, S: {}, P: {}, Q: {}, prior: { S: { 'Mage:0': [1], 'Tank:1': [2] }, P: {}, Q: {} } },
  };
  const m = { b: [1, 2, 3, 4, 5], r: [6, 7, 8, 9, 10] };
  assert.ok(Math.abs(matchLogit(data)(m) - 2) < 1e-9);
  assert.equal(matchLogit({ ...data, fm: { k: 1, S: {}, P: {}, Q: {} } })(m), 0);
});

test('a champion the player is on a run with counts more than the same games long ago', () => {
  const lane = [0, 0, 0, 0, 0, 0, 0];
  const game = (i, won) => ({
    id: `g${i}`, start: i, role: 0, side: 'b',
    m: { b: [1, 2, 3, 4, 5], r: [6, 7, 8, 9, 10], w: won ? 1 : 0, lb: Array(5).fill(lane), lr: Array(5).fill(lane), f: [0, 0, 0, 0, 0] },
  });
  const data = { champ: {}, off: [0, 0, 0, 0, 0], syn: [], vs: [], tags: {} };
  const other = Array.from({ length: 40 }, (_, i) => ({ ...game(100 + i, i % 2 === 0), m: { ...game(0, i % 2 === 0).m, b: [50, 2, 3, 4, 5] } }));
  const wins = (from) => Array.from({ length: 40 }, (_, i) => game(i, i >= from ? from === 20 : from !== 20));
  const delta = (games) => analyzePlayers(data, new Map([['p', [...games, ...other]]])).rows.find((r) => r.champion_id === 1).delta;
  // Same record, 20-20: wins last versus wins first
  assert.ok(delta(wins(20)) > delta(wins(0)));
});
