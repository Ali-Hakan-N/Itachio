// Backtest of the personal layer: does adding the player's comfort to the draft predict
// their games better, and with which settings? Pure functions.
//
// The team's games are split by time into FOLDS + 1 blocks. For every block after the
// first, the player statistics are built only from the games before it (analyze.js, the
// same as the collector writes: season, the patch of the game, the line-up), and every game
// of the block is predicted as
//   p(win) = sigmoid(draft logit + personal delta)
// with the personal delta of the app (desktop model.js personalFor and personalDelta, so
// the code measured is the code that runs). Each variant changes the options of
// personalDelta; the score is log loss (lower is better) and Brier, next to "none"
// (the draft alone).
//
// Limits: the stored games have no lane statistics, so the early part of delta is left
// out (the late part, familiarity and form stay). The lane opponent is taken as unseen
// (laneKnown 0): PERSONAL_COUNTERED is a choice of how to rank, not a prediction, and
// is not measured here.

const path = require('node:path');
const { analyzePlayers } = require('./analyze');
const { matchLogit } = require('../model/predict');

const Engine = require(path.join(__dirname, '..', '..', '..', 'desktop', 'src', 'renderer', 'model.js'));

const ROLES = ['top', 'jungle', 'middle', 'bottom', 'utility'];
const FOLDS = 4;
const TEAM_SIZE = 5;
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** player_games rows -> Map player id -> games as analyze.js reads them, oldest first */
function gamesFromRows(rows) {
  const out = new Map();
  for (const r of rows) {
    const blue = r.side === 'blue';
    const g = {
      id: r.match_id,
      start: new Date(r.started_at).getTime(),
      patch: r.patch,
      side: blue ? 'b' : 'r',
      role: ROLES.indexOf(r.role),
      lineup: r.lineup || '',
      m: { b: r.blue, r: r.red, w: blue === !!r.win ? 1 : 0 },
    };
    if (g.role < 0 || !Array.isArray(r.blue) || !Array.isArray(r.red)) continue;
    if (!out.has(r.player_id)) out.set(r.player_id, []);
    out.get(r.player_id).push(g);
  }
  for (const games of out.values()) games.sort((a, b) => a.start - b.start);
  return out;
}

/** analyze.js rows of one key -> the source the app reads ({ byKey, unplayed }) */
function sourceOf(rows) {
  const byKey = {};
  let unplayed = 0;
  for (const r of rows) {
    if (!r.champion_id) unplayed = r.delta;
    else byKey[`${r.champion_id}:${r.role}`] = { delta: r.delta, games: r.games, mastery: r.mastery || 0 };
  }
  return { byKey, unplayed };
}

const groupRows = (rows) => {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.player_id)) by.set(r.player_id, []);
    by.get(r.player_id).push(r);
  }
  return by;
};

/** The statistics of every player from these games, as the app gets them: { id: { season, history: { patch: source }, team } } */
function statsFrom(data, byPlayer, mastery, patches) {
  const stats = {};
  const at = (id) => (stats[id] ||= { season: null, history: {}, team: {} });
  for (const [id, rows] of groupRows(analyzePlayers(data, byPlayer, mastery).rows)) at(id).season = sourceOf(rows);
  for (const patch of patches) {
    const onPatch = new Map([...byPlayer].map(([id, gs]) => [id, gs.filter((g) => g.patch === patch)]).filter(([, gs]) => gs.length));
    if (!onPatch.size) continue;
    for (const [id, rows] of groupRows(analyzePlayers(data, onPatch, mastery).rows)) at(id).history[patch] = sourceOf(rows);
  }
  const team = new Map();
  for (const [id, games] of byPlayer) {
    for (const g of games) {
      if (g.lineup.split(',').length !== TEAM_SIZE) continue;
      const key = `${id}|${g.lineup}`;
      if (!team.has(key)) team.set(key, []);
      team.get(key).push(g);
    }
  }
  if (team.size) {
    for (const [key, rows] of groupRows(analyzePlayers(data, team, mastery).rows)) {
      const [id, lineup] = key.split('|');
      at(id).team[lineup] = sourceOf(rows);
    }
  }
  return stats;
}

/**
 * @param data      exported model (a model snapshot)
 * @param byPlayer  Map player id -> games (gamesFromRows)
 * @param variants  [{ name, options | null }]; null options = no personal layer
 * @param mastery   optional Map player id -> Map champion id -> 0..1
 * @returns { folds, games, results: [{ name, n, logLoss, brier, meanAbsDelta, seVsFirst }] }
 */
function backtestPersonal({ data, byPlayer, variants, mastery = new Map(), folds = FOLDS }) {
  const logit = matchLogit(data);
  const sd = Engine.strengthSd(data);
  const tags = data.tags || {};
  const all = [...byPlayer.values()].flat().map((g) => g.start).sort((a, b) => a - b);
  const results = variants.map((v) => ({ name: v.name, n: 0, loss: 0, brier: 0, abs: 0, diff: 0, diff2: 0 }));
  if (all.length < (folds + 1) * 10) return { folds: 0, games: all.length, results: results.map(finish) };
  const edges = Array.from({ length: folds + 2 }, (_, k) => (k > folds ? Infinity : all[Math.floor((k * all.length) / (folds + 1))]));

  for (let k = 1; k <= folds; k++) {
    const from = edges[k];
    const to = edges[k + 1];
    const train = new Map([...byPlayer].map(([id, gs]) => [id, gs.filter((g) => g.start < from)]).filter(([, gs]) => gs.length));
    const test = [...byPlayer].flatMap(([id, gs]) => gs.filter((g) => g.start >= from && g.start < to).map((g) => ({ id, g })));
    if (!train.size || !test.length) continue;
    const stats = statsFrom(data, train, mastery, new Set(test.map((t) => t.g.patch)));
    for (const { id, g } of test) {
      const own = stats[id];
      const blue = g.side === 'b';
      const z = (blue ? 1 : -1) * logit(g.m);
      const y = (blue ? g.m.w === 1 : g.m.w === 0) ? 1 : 0;
      const championId = (blue ? g.m.b : g.m.r)[g.role];
      const ids = g.lineup ? g.lineup.split(',') : [];
      const playerStats = own ? { [id]: { season: own.season, history: own.history[g.patch], team: own.team } } : {};
      const personal = Engine.personalFor(playerStats, id, ids, (c) => tags[c] || 'None');
      let base = null;
      results.forEach((r, i) => {
        const options = variants[i].options;
        const d = options && personal
          ? Engine.personalDelta(personal, { championId, role: ROLES[g.role], tag: tags[championId] || 'None', sd, laneKnown: 0 }, options).delta
          : 0;
        const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(z + d)));
        r.n++;
        const loss = y ? -Math.log(p) : -Math.log(1 - p);
        if (base === null) base = loss;
        r.loss += loss;
        r.diff += loss - base;
        r.diff2 += (loss - base) ** 2;
        r.brier += (y - p) ** 2;
        r.abs += Math.abs(d);
      });
    }
  }
  return { folds, games: all.length, results: results.map(finish) };
}

function finish(r) {
  // seVsFirst: standard error of the log loss difference with the first variant, game by game
  const mean = r.n ? r.diff / r.n : 0;
  const seVsFirst = r.n > 1 ? Math.sqrt(Math.max(0, r.diff2 / r.n - mean * mean) / (r.n - 1)) : 0;
  return { name: r.name, n: r.n, logLoss: r.n ? r.loss / r.n : NaN, brier: r.n ? r.brier / r.n : NaN, meanAbsDelta: r.n ? r.abs / r.n : 0, seVsFirst };
}

/** The variants compared by default: none, the v1.11 layer, the current one and a sweep */
function defaultVariants() {
  const out = [
    { name: 'none (draft only)', options: null },
    { name: 'v1.11: sources summed, hard cap 1.5 SD', options: { merge: 'sum', soft: false, cap: 1.5, mainGain: 1 } },
    { name: 'current', options: {} },
  ];
  for (const cap of [0.3, 0.6, 1, 1.5, Infinity]) {
    for (const weight of [0.5, 1, 1.5]) out.push({ name: `cap ${cap === Infinity ? 'none' : `${cap} SD`}, weight ${weight}`, options: { cap, weight } });
  }
  return out;
}

module.exports = { backtestPersonal, gamesFromRows, defaultVariants, sourceOf };
