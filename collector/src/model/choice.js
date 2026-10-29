// How much players pick against the champions they face. Pure functions.
//
// The app looks ahead: while enemy picks are still open, a candidate is scored by what
// it is worth after the enemy answers it (desktop model.js). That needs a model of how
// the enemy chooses when answering. It is learned from the matches with one parameter, λ:
//
//   answering:     P(Y in role q) ∝ popularity(Y, q) × exp(λ × M(Y))
//   not answering: P(Y in role q) ∝ popularity(Y, q)
//   M(Y) = Σ over the five opponents of the model's matchup of Y (role q) against them
//
// Pick order is not in the match data, and only the side that picks later can answer:
// if both sides were modeled as answering, a counterpick seen from the other side looks
// like a bad pick and the two cancel out. So every pick is a 50/50 mixture of the two
// (on average a pick sees about half of the enemy picks). popularity is Y's share of a
// team's games in role q (divided by 1 - its ban rate); champions on the board and bans
// are not available. λ = 0 means picks only follow popularity; larger λ means players
// pick what beats the champions they face. λ is the maximum likelihood estimate over
// the real picks (grid, then golden section), its standard error from the curvature.

const CANDIDATE_MIN_GAMES = 20;
const MAX_MATCHES = 5000; // the newest; enough for one parameter
const MAX_LAMBDA = 50;

const dot = (a, b) => {
  if (!a || !b) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Matchup a (role ra) against b (role rb) from an exported model, in log-odds */
function matchupOf(data) {
  const vs = new Map();
  for (const list of [data.vs, data.vsE]) {
    for (const [a, ra, b, rb, w] of list || []) {
      const k = `${a}:${ra}:${b}:${rb}`;
      const r = `${b}:${rb}:${a}:${ra}`;
      vs.set(k, (vs.get(k) || 0) + w);
      vs.set(r, (vs.get(r) || 0) - w);
    }
  }
  const tv = new Map();
  for (const [key, w] of Object.entries(data.tv || {})) {
    const [x, y] = key.split(':');
    tv.set(`${x}:${y}`, w);
    tv.set(`${y}:${x}`, x === y ? w : -w);
  }
  const tag = (c) => (data.tags || {})[c] || 'None';
  const fm = data.fm;
  return (a, ra, b, rb) => {
    let v = vs.get(`${a}:${ra}:${b}:${rb}`) || 0;
    if (fm) v += dot(fm.P[`${a}:${ra}`], fm.Q[`${b}:${rb}`]) - dot(fm.P[`${b}:${rb}`], fm.Q[`${a}:${ra}`]);
    return v + (tv.get(`${tag(a)}:${tag(b)}`) || 0);
  };
}

/**
 * @param data    exported model (index.js exportModel)
 * @param matches compact matches
 * @returns { lambda, se, picks } or null without enough data
 */
function counterpickTendency(data, matches) {
  if (!data.matches) return null;
  const matchup = matchupOf(data);
  const banRate = data.banRate || {};
  const byRole = [[], [], [], [], []];
  for (const [key, [, games]] of Object.entries(data.champ)) {
    if (games < CANDIDATE_MIN_GAMES) continue;
    const [c, r] = key.split(':').map(Number);
    const pop = games / (2 * data.matches) / Math.max(0.1, 1 - (banRate[c] || 0));
    byRole[r].push({ c, logPop: Math.log(pop) });
  }

  // One choice per pick: the M of every available candidate, and which one was picked
  const choices = [];
  for (const m of matches.slice(-MAX_MATCHES)) {
    const banned = new Set(m.x || []);
    const onBoard = new Set([...m.b, ...m.r]);
    for (const [team, opp] of [[m.b, m.r], [m.r, m.b]]) {
      for (let q = 0; q < 5; q++) {
        const picked = team[q];
        const cands = byRole[q].filter((k) => k.c === picked || (!onBoard.has(k.c) && !banned.has(k.c)));
        if (cands.length < 2 || !cands.some((k) => k.c === picked)) continue;
        const M = new Float64Array(cands.length);
        const logPop = new Float64Array(cands.length);
        let chosen = -1;
        cands.forEach((k, i) => {
          let s = 0;
          for (let j = 0; j < 5; j++) s += matchup(k.c, q, opp[j], j);
          M[i] = s;
          logPop[i] = k.logPop;
          if (k.c === picked) chosen = i;
        });
        choices.push({ M, logPop, chosen });
      }
    }
  }
  if (choices.length < 1000) return null;

  // Log-likelihood of the mixture at lambda
  const logLik = (lambda) => {
    let ll = 0;
    for (const { M, logPop, chosen } of choices) {
      let maxA = -Infinity;
      let maxB = -Infinity;
      for (let i = 0; i < M.length; i++) {
        maxA = Math.max(maxA, logPop[i] + lambda * M[i]);
        maxB = Math.max(maxB, logPop[i]);
      }
      let zA = 0;
      let zB = 0;
      for (let i = 0; i < M.length; i++) {
        zA += Math.exp(logPop[i] + lambda * M[i] - maxA);
        zB += Math.exp(logPop[i] - maxB);
      }
      const pA = Math.exp(logPop[chosen] + lambda * M[chosen] - maxA) / zA;
      const pB = Math.exp(logPop[chosen] - maxB) / zB;
      ll += Math.log(0.5 * pA + 0.5 * pB);
    }
    return ll;
  };
  // Coarse grid, then golden section around the best point
  const grid = [0, 0.25, 0.5, 1, 2, 4, 8, 16, MAX_LAMBDA];
  const values = grid.map(logLik);
  let best = values.indexOf(Math.max(...values));
  let lo = grid[Math.max(0, best - 1)];
  let hi = grid[Math.min(grid.length - 1, best + 1)];
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - g * (hi - lo);
  let x2 = lo + g * (hi - lo);
  let f1 = logLik(x1);
  let f2 = logLik(x2);
  for (let it = 0; it < 30 && hi - lo > 1e-3; it++) {
    if (f1 > f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - g * (hi - lo);
      f1 = logLik(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + g * (hi - lo);
      f2 = logLik(x2);
    }
  }
  const lambda = (lo + hi) / 2;
  // Standard error from the curvature (one-sided at 0)
  const h = Math.max(0.01, lambda * 0.05);
  const at = Math.max(lambda, h);
  const curv = -(logLik(at + h) - 2 * logLik(at) + logLik(at - h)) / (h * h);
  return { lambda, se: curv > 0 ? 1 / Math.sqrt(curv) : null, picks: choices.length };
}

module.exports = { counterpickTendency, matchupOf };
