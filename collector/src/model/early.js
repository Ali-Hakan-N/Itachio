// Early game model: learns what a draft does to the first minutes of a game, where
// the signal is far stronger than in the final result, and hands it to the win model
// as two features. Pure functions; train.js decides whether the result is kept.
//
// Why: a single win or loss says little about one matchup, because most of the game
// is decided by everything else. CS, plates and leads at 10 minutes, and who takes the
// first objectives, depend much more directly on the champions involved, so the same
// matches measure a matchup many times more precisely.
//
// How (all of it learned from the matches):
//   1. Early state S of a match, seen from blue: per role, blue's player minus red's
//      player in the same role (CS by 10 minutes, turret plates, gold+xp lead early in
//      and at the end of the laning phase, takedowns in the first minutes), plus the
//      first objectives (blood, tower, dragon, herald, grubs).
//   2. Surrogate: logistic regression of the result on S. It says how much each part
//      of the early game is worth in win probability (log-odds), so the five lanes and
//      the objectives are put on one scale: A_k = beta_k · S_k for each component k.
//   3. Draft effects: for every component, ridge regression of A_k on the draft
//      (champion strength, off-role, same-team pairs, enemy pairs in any roles). Each
//      lane's advantage is mostly decided in that lane, so each regression sees little
//      noise from the rest of the map. The penalty of each is chosen on held-out matches.
//   4. Draft features for the win model: the pair part of the predicted early advantage,
//      synergy (same-team pairs) and matchups (enemy pairs) separately. Matches are
//      cross-fitted: a match's features come from models that never saw it.
//
// The win model then learns how much of this early advantage turns into wins (one
// weight each for synergy and matchups) and keeps the layer only if cross-validated win
// predictions improve. The final result is always "does the team win".

// Entries of riot/parse.js laneOf()
const LANE_FIELDS = ['laneCs10', 'jungleCs10', 'plates', 'earlyLead', 'laneLead', 'earlyTakedowns', 'soloKills'];
const LANE_LEN = LANE_FIELDS.length;
const ROLE_DIM = 5; // CS by 10 minutes, plates, early lead, laning lead, early takedowns
const TEAM_DIM = 5; // first blood, tower, dragon, herald, grubs
const COMPONENTS = 6; // five roles and the objectives
const DIM = ROLE_DIM * 5 + TEAM_DIM;
const LAMBDA_GRID = [3, 10, 30, 100, 300, 1000, 3000]; // ridge penalty in games
const CG_ITERS = 80;
const SURROGATE_L2 = 1; // tiny, only keeps the solve stable
const DRAFT_GROUPS = ['c', 'o', 's', 'v'];

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clampP = (p) => Math.min(Math.max(p, 1e-9), 1 - 1e-9);

/** Early state of a compact match, or null when the match has no early data */
function earlyState(m) {
  if (!m.lb || !m.lr || !m.f || m.lb.length !== 5 || m.lr.length !== 5) return null;
  const s = new Float64Array(DIM);
  for (let r = 0; r < 5; r++) {
    const b = m.lb[r];
    const x = m.lr[r];
    if (!b || !x || b.length !== LANE_LEN || x.length !== LANE_LEN) return null;
    const v = (a, i) => a[i] ?? 0;
    const o = r * ROLE_DIM;
    s[o] = (v(b, 0) + v(b, 1) - v(x, 0) - v(x, 1)) / 10; // CS by 10 minutes, in tens
    s[o + 1] = v(b, 2) - v(x, 2);
    s[o + 2] = v(b, 3) - v(x, 3);
    s[o + 3] = v(b, 4) - v(x, 4);
    s[o + 4] = v(b, 5) - v(x, 5);
  }
  for (let i = 0; i < TEAM_DIM; i++) s[ROLE_DIM * 5 + i] = m.f[i] || 0;
  return s;
}

// Component of feature i: its role, or 5 for the objectives
const componentOf = (i) => Math.min(Math.floor(i / ROLE_DIM), 5);

/** Solves a small dense system (Gauss-Jordan with partial pivoting) */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let j = c; j <= n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c || !M[r][c]) continue;
      const f = M[r][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row[n]);
}

/** Logistic regression of the result on the early state (Newton). Returns { beta, bias } */
function fitSurrogate(S, y, rows) {
  const n = DIM + 1;
  let w = new Array(n).fill(0);
  for (let it = 0; it < 25; it++) {
    const H = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (const r of rows) {
      const x = S[r];
      let z = w[DIM];
      for (let i = 0; i < DIM; i++) z += w[i] * x[i];
      const p = sigmoid(z);
      const e = y[r] - p;
      const h = p * (1 - p);
      for (let i = 0; i <= DIM; i++) {
        const xi = i === DIM ? 1 : x[i];
        g[i] += e * xi;
        if (!xi) continue;
        for (let j = 0; j <= i; j++) {
          const xj = j === DIM ? 1 : x[j];
          H[i][j] += h * xi * xj;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) H[j][i] = H[i][j];
      if (i < DIM) {
        H[i][i] += SURROGATE_L2;
        g[i] -= SURROGATE_L2 * w[i];
      }
    }
    const step = solve(H, g);
    let size = 0;
    w = w.map((v, i) => {
      size = Math.max(size, Math.abs(step[i]));
      return v + step[i];
    });
    if (size < 1e-7) break;
  }
  return { beta: Float64Array.from(w.slice(0, DIM)), bias: w[DIM] };
}

/** Early advantage per component, in log-odds of winning: A[k] for one match */
function components(beta, s) {
  const a = new Float64Array(COMPONENTS);
  for (let i = 0; i < DIM; i++) a[componentOf(i)] += beta[i] * s[i];
  return a;
}

/**
 * Ridge regression of target over the draft columns, conjugate gradient on
 * (X'X + lambda I) w = X'(t - mean). Returns { w, mean }.
 */
function ridge(D, rows, on, target, lambda, w0) {
  const m = D.keys.length;
  let mean = 0;
  for (const r of rows) mean += target[r];
  mean /= rows.length || 1;
  const Xv = (w, r) => {
    let s = 0;
    for (let j = D.rowPtr[r]; j < D.rowPtr[r + 1]; j++) if (on[D.cols[j]]) s += D.vals[j] * w[D.cols[j]];
    return s;
  };
  const XtX = (p) => {
    const out = new Float64Array(m);
    for (const r of rows) {
      const v = Xv(p, r);
      if (!v) continue;
      for (let j = D.rowPtr[r]; j < D.rowPtr[r + 1]; j++) if (on[D.cols[j]]) out[D.cols[j]] += D.vals[j] * v;
    }
    for (let i = 0; i < m; i++) out[i] = on[i] ? out[i] + lambda * p[i] : 0;
    return out;
  };
  const w = w0 ? Float64Array.from(w0) : new Float64Array(m);
  const b = new Float64Array(m);
  for (const r of rows) {
    const t = target[r] - mean;
    for (let j = D.rowPtr[r]; j < D.rowPtr[r + 1]; j++) if (on[D.cols[j]]) b[D.cols[j]] += D.vals[j] * t;
  }
  const Aw = XtX(w);
  const res = Float64Array.from(b, (v, i) => v - Aw[i]);
  const p = Float64Array.from(res);
  let rr = res.reduce((s, v) => s + v * v, 0);
  const stop = 1e-10 * (b.reduce((s, v) => s + v * v, 0) || 1);
  for (let it = 0; it < CG_ITERS && rr > stop; it++) {
    const Ap = XtX(p);
    let pAp = 0;
    for (let i = 0; i < m; i++) pAp += p[i] * Ap[i];
    if (!pAp) break;
    const alpha = rr / pAp;
    for (let i = 0; i < m; i++) {
      w[i] += alpha * p[i];
      res[i] -= alpha * Ap[i];
    }
    const rrNew = res.reduce((s, v) => s + v * v, 0);
    const beta = rrNew / rr;
    for (let i = 0; i < m; i++) p[i] = res[i] + beta * p[i];
    rr = rrNew;
  }
  return { w, mean };
}

/** Predicted pair part of the early advantage of row r: [synergy, matchups] */
function pairParts(D, r, ws, wv, isS, isV) {
  let s = 0;
  let v = 0;
  for (let j = D.rowPtr[r]; j < D.rowPtr[r + 1]; j++) {
    const c = D.cols[j];
    if (isS[c]) s += D.vals[j] * ws[c];
    else if (isV[c]) v += D.vals[j] * wv[c];
  }
  return [s, v];
}

/**
 * Fits the surrogate and the per-component draft regressions on fitRows.
 * lambdas: one per component (chosen by tune()). Returns summed pair weights.
 */
function fitEarly(D, S, rows, on, lambdas, warm) {
  const sur = fitSurrogate(S, D.y, rows);
  const A = Array.from({ length: COMPONENTS }, () => new Float64Array(D.y.length));
  for (const r of rows) {
    const a = components(sur.beta, S[r]);
    for (let k = 0; k < COMPONENTS; k++) A[k][r] = a[k];
  }
  const ws = new Float64Array(D.keys.length);
  const wv = new Float64Array(D.keys.length);
  const fits = [];
  for (let k = 0; k < COMPONENTS; k++) {
    const f = ridge(D, rows, on, A[k], lambdas[k], warm?.[k]);
    fits.push(f.w);
    for (let i = 0; i < D.keys.length; i++) {
      ws[i] += f.w[i];
      wv[i] += f.w[i];
    }
  }
  return { sur, ws, wv, fits };
}

/** Penalty per component, chosen by squared error on held-out matches */
function tune(D, S, train, valid, on, log) {
  const sur = fitSurrogate(S, D.y, train);
  const A = Array.from({ length: COMPONENTS }, () => new Float64Array(D.y.length));
  for (const r of [...train, ...valid]) {
    const a = components(sur.beta, S[r]);
    for (let k = 0; k < COMPONENTS; k++) A[k][r] = a[k];
  }
  const lambdas = [];
  for (let k = 0; k < COMPONENTS; k++) {
    let best = null;
    let warm = null;
    // From strong to weak penalty, each solve starts from the previous one
    for (const lambda of [...LAMBDA_GRID].reverse()) {
      const f = ridge(D, train, on, A[k], lambda, warm);
      warm = f.w;
      let err = 0;
      for (const r of valid) {
        let p = f.mean;
        for (let j = D.rowPtr[r]; j < D.rowPtr[r + 1]; j++) if (on[D.cols[j]]) p += D.vals[j] * f.w[D.cols[j]];
        err += (A[k][r] - p) ** 2;
      }
      if (!best || err < best.err) best = { lambda, err };
    }
    lambdas.push(best.lambda);
  }
  log(`  early game penalties (games): ${lambdas.join(', ')}`);
  return lambdas;
}

/** Cross-validated quality of the surrogate: how well the early state alone predicts the result */
function surrogateQuality(D, S, rows, folds) {
  let loss = 0;
  let right = 0;
  for (let f = 0; f < folds; f++) {
    const train = rows.filter((r) => D.fold[r] !== f);
    const test = rows.filter((r) => D.fold[r] === f);
    if (!train.length || !test.length) continue;
    const { beta, bias } = fitSurrogate(S, D.y, train);
    for (const r of test) {
      let z = bias;
      for (let i = 0; i < DIM; i++) z += beta[i] * S[r][i];
      const p = clampP(sigmoid(z));
      loss -= D.y[r] ? Math.log(p) : Math.log(1 - p);
      if ((p > 0.5) === (D.y[r] === 1)) right++;
    }
  }
  return { logloss: loss / rows.length, accuracy: right / rows.length };
}

/**
 * @param D       design matrix of train.js (needs keys, groups, rowPtr, cols, vals, y, fold)
 * @param matches compact matches, same order as D's rows
 * @param codes   group name -> code in D.groups (train.js GROUP_CODE)
 * @returns null when fewer than minMatches have early data, otherwise
 *   { matches, surrogate, lambdas, features: { s: Float64Array, v: Float64Array } per row,
 *     weights: { s, v } per column (early log-odds per pair, from all early matches) }
 */
function earlyModel(D, matches, { folds, minMatches, codes, log = () => {} }) {
  const S = matches.map(earlyState);
  const rows = [];
  S.forEach((s, r) => s && rows.push(r));
  if (rows.length < minMatches) {
    log(`model: early game   ${rows.length} matches with early data, ${minMatches} needed`);
    return null;
  }
  const on = new Uint8Array(D.keys.length);
  const isS = new Uint8Array(D.keys.length);
  const isV = new Uint8Array(D.keys.length);
  for (let i = 0; i < D.keys.length; i++) {
    const g = D.groups[i];
    if (DRAFT_GROUPS.some((name) => codes[name] === g)) on[i] = 1;
    if (g === codes.s) isS[i] = 1;
    if (g === codes.v) isV[i] = 1;
  }

  const surrogate = surrogateQuality(D, S, rows, folds);
  log(`model: early game   ${rows.length} matches; early state alone predicts the result ${(surrogate.accuracy * 100).toFixed(1)}% (logloss ${surrogate.logloss.toFixed(4)})`);

  const lambdas = tune(D, S, rows.filter((r) => D.fold[r] !== 0), rows.filter((r) => D.fold[r] === 0), on, log);

  // Cross-fitting: early matches get features from models that did not see them
  const fs = new Float64Array(D.y.length);
  const fv = new Float64Array(D.y.length);
  for (let f = 0; f < folds; f++) {
    const train = rows.filter((r) => D.fold[r] !== f);
    const test = rows.filter((r) => D.fold[r] === f);
    if (!test.length) continue;
    const fit = fitEarly(D, S, train, on, lambdas);
    for (const r of test) [fs[r], fv[r]] = pairParts(D, r, fit.ws, fit.wv, isS, isV);
  }
  // Everything else (matches without early data) from the model on all early matches
  const full = fitEarly(D, S, rows, on, lambdas);
  const hasEarly = new Uint8Array(D.y.length);
  for (const r of rows) hasEarly[r] = 1;
  for (let r = 0; r < D.y.length; r++) if (!hasEarly[r]) [fs[r], fv[r]] = pairParts(D, r, full.ws, full.wv, isS, isV);

  const ws = Float64Array.from(full.ws, (v, i) => (isS[i] ? v : 0));
  const wv = Float64Array.from(full.wv, (v, i) => (isV[i] ? v : 0));
  return {
    matches: rows.length,
    surrogate: { ...surrogate, beta: Array.from(full.sur.beta) },
    lambdas,
    features: { s: fs, v: fv },
    weights: { s: ws, v: wv },
  };
}

module.exports = { earlyModel, earlyState, fitSurrogate, LANE_FIELDS, DIM };
