const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePlayers } = require('../src/players/analyze');
const { lineupOf, byLineup, gameRow } = require('../src/players');
const { matchLogit } = require('../src/model/predict');

// A flat model: every champion average, early state priced on CS by 10 minutes only
const champ = {};
for (const c of [1, 2, 3, 4, 5, 11, 12, 13, 14, 15, 20]) for (let r = 0; r < 5; r++) champ[`${c}:${r}`] = [0, 500, 1];
const beta = new Array(30).fill(0);
for (let r = 0; r < 5; r++) beta[r * 3] = 0.3; // per 10 CS
const data = { matches: 1000, champ, off: [0, 0, 0, 0, 0], bias: 0, early: { beta, laneMean: {} }, tags: {} };

// A game of the player in top, on blue: lane CS difference cs, result win
function game(id, champion, cs, win, start) {
  const lane = (n) => [n, 0, 0, 0, 0, 0, 0];
  return {
    id, start, side: 'b', role: 0,
    m: {
      b: [champion, 2, 3, 4, 5], r: [11, 12, 13, 14, 15], w: win ? 1 : 0,
      lb: [lane(80 + cs / 2), lane(0), lane(70), lane(70), lane(10)],
      lr: [lane(80 - cs / 2), lane(0), lane(70), lane(70), lane(10)],
      f: [0, 0, 0, 0, 0],
    },
  };
}

test('player analysis: a champion the player laning well on scores above one they play at their average', () => {
  const games = [];
  let t = 0;
  // Champion 1: wins lane by 20 CS every game, results 50/50 (the team decides them)
  for (let i = 0; i < 40; i++) games.push(game(`A${i}`, 1, 20, i % 2 === 0, t++));
  // Champion 20: even lanes, 50/50
  for (let i = 0; i < 40; i++) games.push(game(`B${i}`, 20, 0, i % 2 === 0, t++));
  const { rows, familiarity } = analyzePlayers(data, new Map([['p1', games]]));
  const row = (c) => rows.find((r) => r.champion_id === c);
  assert.ok(row(1).early > 0 && row(20).early < 0, `${row(1).early} ${row(20).early}`);
  assert.ok(row(1).delta > row(20).delta);
  // Lost games after won lanes count against the late part, not the early part
  assert.ok(row(1).late < 0);
  assert.equal(row(1).games, 40);
  assert.equal(row(1).wins, 20);
  assert.equal(row(1).role, 'top');
  const unplayed = rows.find((r) => r.champion_id === 0);
  assert.equal(unplayed.delta, familiarity);
});

test('player analysis: few games are shrunk toward the player average', () => {
  const games = [];
  for (let i = 0; i < 40; i++) games.push(game(`B${i}`, 20, 0, i % 2 === 0, i));
  games.push(game('A0', 1, 20, true, 100), game('A1', 1, 20, true, 101));
  const few = analyzePlayers(data, new Map([['p1', games]])).rows.find((r) => r.champion_id === 1);
  for (let i = 2; i < 30; i++) games.push(game(`A${i}`, 1, 20, i % 2 === 0, 100 + i));
  const many = analyzePlayers(data, new Map([['p1', games]])).rows.find((r) => r.champion_id === 1);
  assert.ok(many.early > few.early, `${few.early} -> ${many.early}`);
});

test('match logit from an exported model follows strength, pairs and matchups', () => {
  const m = { b: [1, 2, 3, 4, 5], r: [11, 12, 13, 14, 15] };
  const strong = { ...data, champ: { ...champ, '1:0': [0.5, 500, 1] } };
  assert.ok(matchLogit(strong)(m) > 0.4);
  assert.ok(matchLogit({ ...data, vs: [[1, 0, 11, 0, -0.3]] })(m) < -0.2);
  assert.ok(matchLogit({ ...data, syn: [[1, 0, 2, 1, 0.2]] })(m) > 0.1);
});

test("line-up: the team members on the player's side, sorted, the player included", () => {
  const teamOf = new Map([['pa', 'a'], ['pb', 'b'], ['pc', 'c']]);
  assert.equal(lineupOf('b', { mates: ['pc', 'x1', 'pa', 'x2'] }, teamOf), 'a,b,c');
  // Alone, or only with players outside the team: no line-up
  assert.equal(lineupOf('a', { mates: ['x1', 'x2', 'x3', 'x4'] }, teamOf), '');
  assert.equal(lineupOf('a', {}, teamOf), '');
});

test("line-up games: every player's games split by line-up, solo games left out", () => {
  const games = [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }];
  const lineups = new Map([['a', new Map([['g1', 'a,b'], ['g2', ''], ['g3', 'a,b']])]]);
  const out = byLineup(new Map([['a', games]]), lineups);
  assert.deepEqual([...out.keys()], ['a|a,b']);
  assert.deepEqual(out.get('a|a,b').map((g) => g.id), ['g1', 'g3']);
});

test("game row: the player's champion, side and result, both teams in role order", () => {
  const g = { id: 'TR1_1', start: 0, patch: '16.21', q: 440, dur: 1800, side: 'r', role: 1, m: { b: [1, 2, 3, 4, 5], r: [11, 12, 13, 14, 15], w: 0 }, k: 3, d: 1, a: 7, cs: 160 };
  const row = gameRow('a', g, 'a,b');
  assert.equal(row.champion_id, 12);
  assert.equal(row.role, 'jungle');
  assert.equal(row.side, 'red');
  assert.equal(row.win, true);
  assert.deepEqual(row.blue, [1, 2, 3, 4, 5]);
  assert.equal(row.lineup, 'a,b');
});

test('history game: found by account, with its patch, team-mates and numbers; remakes are skipped', () => {
  const { historyGame } = require('../src/players/history');
  const roles = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
  const raw = {
    metadata: { matchId: 'EUW1_5' },
    info: {
      queueId: 420, gameDuration: 1800, gameVersion: '16.21.1', gameStartTimestamp: 5, teams: [],
      participants: roles.flatMap((r, i) => [
        { puuid: i === 2 ? 'me' : `b${i}`, championId: i + 1, teamPosition: r, teamId: 100, win: true, kills: i, deaths: 1, assists: 2, totalMinionsKilled: 100, neutralMinionsKilled: 20 },
        { puuid: `r${i}`, championId: i + 11, teamPosition: r, teamId: 200, win: false },
      ]),
    },
  };
  const g = historyGame(raw, 'me');
  assert.equal(g.patch, '16.21');
  assert.equal(g.side, 'b');
  assert.equal(g.role, 2);
  assert.equal(g.q, 420);
  assert.deepEqual(g.mates, ['b0', 'b1', 'b3', 'b4']);
  assert.equal(g.k, 2);
  assert.equal(g.cs, 120);
  assert.ok(historyGame({ ...raw, info: { ...raw.info, gameDuration: 100 } }, 'me').skip);
});
