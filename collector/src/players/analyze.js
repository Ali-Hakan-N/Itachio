// How well each player does on each champion, from their own matches. Pure functions.
//
// Every game of a player is compared with what the model expects from the draft alone,
// in two parts that keep the player apart from their team:
//   early  their lane result (CS by 10 minutes, laning leads, priced in log-odds by the
//          early game surrogate) minus what an average player gets in that matchup
//          (laneMean of their champion minus laneMean of the lane opponent's). It only
//          depends on the player and their opponent, not on teammates.
//   late   the result minus what the model expected from the draft plus that early part:
//          y - sigmoid(draft logit + early). Losing after winning the lane counts here,
//          and much of it is the team; it is noisy, so it is shrunk hard.
// Both are taken relative to the player's own average, so a value says which champions
// they play better or worse than their usual level:
//   early(c) = Σ (early - player's mean early) / (games + N_E)
//   late(c)  = Σ (late residual - player's mean rate × weight) / (Σ weight + TAU_LATE)
// N_E comes from the data: within- and between-champion variance of the early part over
// all players' champions (method of moments), bounded to [N_E_MIN, N_E_MAX].
// Familiarity: champions a player rarely played. F is the average of both parts over
// games where the player had fewer than FIRST_GAMES earlier games on that champion,
// pooled over the team. A champion with n games gets F × N_FAM / (N_FAM + n) on top, and
// one never played gets F. delta = early + late + familiarity, in log-odds, is what the
// app adds to that player's score for the champion.

const { laneAdvantage } = require('../model/early');
const { matchLogit } = require('../model/predict');

const N_E_MIN = 3;
const N_E_MAX = 50;
const N_E_DEFAULT = 10;
const TAU_LATE = 25; // in units of p(1-p): about 100 games
const FIRST_GAMES = 3;
const N_FAM = 10;
const F_PRIOR = 20; // games of evidence before the familiarity estimate moves freely

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * One player game: { id, start, m (compact match), side: 'b'|'r', role (0-4) }
 * Returns per-game numbers: { champion, role, win, early|null, resid, weight, prior }
 * (prior = earlier games on the same champion), oldest first.
 */
function scoreGames(data, games) {
  const logit = matchLogit(data);
  const beta = data.early?.beta;
  const laneMean = data.early?.laneMean || {};
  const seen = new Map();
  const out = [];
  for (const g of [...games].sort((a, b) => a.start - b.start)) {
    const blue = g.side === 'b';
    const mine = blue ? g.m.b : g.m.r;
    const theirs = blue ? g.m.r : g.m.b;
    const champion = mine[g.role];
    const sign = blue ? 1 : -1;
    let early = null;
    if (beta) {
      const lane = laneAdvantage(beta, g.m, g.role);
      // A champion without an average yet counts as an average lane
      const a = laneMean[`${champion}:${g.role}`] ?? 0;
      const b = laneMean[`${theirs[g.role]}:${g.role}`] ?? 0;
      if (lane !== null) early = sign * lane - (a - b);
    }
    const win = blue ? g.m.w === 1 : g.m.w === 0;
    const p = sigmoid(sign * logit(g.m) + (early ?? 0));
    const key = `${champion}:${g.role}`;
    out.push({ champion, role: g.role, win, early, resid: (win ? 1 : 0) - p, weight: p * (1 - p), prior: seen.get(key) || 0 });
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return out;
}

/** Early shrinkage from within/between champion variance over all players (method of moments) */
function earlyShrinkage(groups) {
  const usable = groups.filter((g) => g.e.length >= 3);
  if (usable.length < 5) return N_E_DEFAULT;
  let within = 0;
  let wn = 0;
  const means = [];
  for (const g of usable) {
    const mean = g.e.reduce((a, b) => a + b, 0) / g.e.length;
    for (const v of g.e) within += (v - mean) ** 2;
    wn += g.e.length - 1;
    means.push({ mean, n: g.e.length });
  }
  const sw2 = within / wn;
  const grand = means.reduce((a, b) => a + b.mean, 0) / means.length;
  const spread = means.reduce((a, b) => a + (b.mean - grand) ** 2, 0) / (means.length - 1);
  const sb2 = spread - means.reduce((a, b) => a + sw2 / b.n, 0) / means.length;
  if (!(sb2 > 0)) return N_E_MAX;
  return Math.min(N_E_MAX, Math.max(N_E_MIN, sw2 / sb2));
}

/**
 * @param data     exported model
 * @param byPlayer Map playerId -> games (see scoreGames)
 * @returns { rows: [{ player_id, champion_id, role, games, wins, early, late, delta }], nE, familiarity }
 */
function analyzePlayers(data, byPlayer) {
  const scored = new Map([...byPlayer].map(([id, games]) => [id, scoreGames(data, games)]));
  // Player means, then every game relative to them
  const rel = new Map();
  for (const [id, games] of scored) {
    const withEarly = games.filter((g) => g.early !== null);
    const meanEarly = withEarly.length ? withEarly.reduce((a, g) => a + g.early, 0) / withEarly.length : 0;
    const w = games.reduce((a, g) => a + g.weight, 0);
    const rate = w ? games.reduce((a, g) => a + g.resid, 0) / w : 0;
    rel.set(id, games.map((g) => ({ ...g, e: g.early === null ? null : g.early - meanEarly, l: g.resid - rate * g.weight })));
  }

  // Champion groups per player
  const groups = [];
  for (const [id, games] of rel) {
    const by = new Map();
    for (const g of games) {
      const key = `${g.champion}:${g.role}`;
      if (!by.has(key)) by.set(key, { id, champion: g.champion, role: g.role, games: [], e: [] });
      const grp = by.get(key);
      grp.games.push(g);
      if (g.e !== null) grp.e.push(g.e);
    }
    groups.push(...by.values());
  }
  const nE = earlyShrinkage(groups);

  // Familiarity, pooled over the team: both parts on a champion's first games
  const first = [...rel.values()].flat().filter((g) => g.prior < FIRST_GAMES);
  const fe = first.filter((g) => g.e !== null);
  const famEarly = fe.reduce((a, g) => a + g.e, 0) / (fe.length + F_PRIOR);
  const famLate = first.reduce((a, g) => a + g.l, 0) / (first.reduce((a, g) => a + g.weight, 0) + TAU_LATE);
  const familiarity = famEarly + famLate;

  const ROLES = ['top', 'jungle', 'middle', 'bottom', 'utility'];
  const rows = [];
  for (const g of groups) {
    const n = g.games.length;
    const early = g.e.reduce((a, b) => a + b, 0) / (g.e.length + nE);
    const late = g.games.reduce((a, x) => a + x.l, 0) / (g.games.reduce((a, x) => a + x.weight, 0) + TAU_LATE);
    rows.push({
      player_id: g.id,
      champion_id: g.champion,
      role: ROLES[g.role],
      games: n,
      wins: g.games.filter((x) => x.win).length,
      early,
      late,
      delta: early + late + (familiarity * N_FAM) / (N_FAM + n),
    });
  }
  for (const id of rel.keys()) {
    rows.push({ player_id: id, champion_id: 0, role: '', games: 0, wins: 0, early: famEarly, late: famLate, delta: familiarity });
  }
  return { rows, nE, familiarity };
}

module.exports = { analyzePlayers, scoreGames };
