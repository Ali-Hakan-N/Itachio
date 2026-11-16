const test = require('node:test');
const assert = require('node:assert/strict');
const { backtestPersonal, gamesFromRows, sourceOf } = require('../src/players/backtest');

// A flat model: every champion average, so the draft alone predicts 50%
const champ = {};
for (const c of [1, 2, 3, 4, 5, 11, 12, 13, 14, 15, 20]) for (let r = 0; r < 5; r++) champ[`${c}:${r}`] = [0, 500, 1];
const data = { matches: 1000, champ, off: [0, 0, 0, 0, 0], bias: 0, tags: {} };

// player_games rows of one player in top on blue: champion 1 wins 3 in 4, champion 20 1 in 4
function rows(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const champion = i % 2 ? 20 : 1;
    const k = Math.floor(i / 2) % 4;
    out.push({
      player_id: 'p1', match_id: `M${i}`, started_at: new Date(Date.UTC(2026, 0, 1) + i * 3600e3).toISOString(),
      patch: '26.1', side: 'blue', role: 'top', champion_id: champion,
      win: champion === 1 ? k !== 0 : k === 0,
      blue: [champion, 2, 3, 4, 5], red: [11, 12, 13, 14, 15], lineup: '',
    });
  }
  return out;
}

test('backtest: stored games come back as analyze.js games, oldest first, with the result from the player\'s side', () => {
  const r = rows(4);
  r.reverse();
  r[0] = { ...r[0], side: 'red', blue: [11, 12, 13, 14, 15], red: [20, 2, 3, 4, 5], win: true };
  const games = gamesFromRows(r).get('p1');
  assert.deepEqual(games.map((g) => g.id), ['M0', 'M1', 'M2', 'M3']);
  const red = games.find((g) => g.side === 'r');
  assert.equal(red.m.w, 0, 'a red win is a blue loss');
  assert.equal(games[0].role, 0);
});

test('backtest: a player who is better on one champion is predicted better with the personal layer', () => {
  const byPlayer = gamesFromRows(rows(400));
  const { folds, results } = backtestPersonal({
    data, byPlayer,
    variants: [{ name: 'none', options: null }, { name: 'open', options: { cap: Infinity, weight: 1 } }],
  });
  assert.equal(folds, 4);
  const [none, open] = results;
  assert.ok(Math.abs(none.logLoss - Math.log(2)) < 1e-9, 'a flat draft is a coin flip');
  assert.ok(open.logLoss < none.logLoss, `${open.logLoss} vs ${none.logLoss}`);
  assert.ok(open.meanAbsDelta > 0 && open.seVsFirst > 0);
  assert.equal(none.n, open.n);
});

test('backtest: too few games give no folds', () => {
  const { folds } = backtestPersonal({ data, byPlayer: gamesFromRows(rows(20)), variants: [{ name: 'none', options: null }] });
  assert.equal(folds, 0);
});

test('backtest: analyze.js rows become the source the app reads', () => {
  const s = sourceOf([
    { champion_id: 0, role: '', delta: -0.05, games: 0 },
    { champion_id: 7, role: 'top', delta: 0.1, games: 12, mastery: 0.5 },
  ]);
  assert.deepEqual(s, { byKey: { '7:top': { delta: 0.1, games: 12, mastery: 0.5 } }, unplayed: -0.05 });
});
