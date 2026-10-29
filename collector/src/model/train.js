// Logistic regression for "does blue win", trained on single matches.
//
//   P(blue wins) = σ(bias + Σ weight × feature)          features: model/features.js
//
// L2 regularization per feature group pulls weights with little data toward 0, so
// a pair seen in a few games has a small effect and no thresholds are needed.
// The regularization strengths are picked on a held-out 10% of the matches with a
// coarse search, then a finer one around the best; the final model is fitted on
// all matches with more iterations.

const { features, groupOf } = require('./features');

const GROUPS = ['c', 'o', 's', 'v', 'ts', 'tv'];
const DEFAULT_GRID = {
  // champion strength
  c: [1e-3, 1e-2, 1e-1],
  // pairs (synergy and matchups share one strength). The strong end lets the model
  // shrink to almost nothing when the pairs carry no real signal.
  pair: [3e-3, 3e-2, 3e-1],
};
const STEPS = { coarse: 150, fine: 300, final: 500 };
const FINE = [1 / Math.sqrt(3), 1, Math.sqrt(3)];
const FIXED_LAMBDA = { o: 1e-4, ts: 1e-3, tv: 1e-3 };

/** Builds a sparse design matrix (CSR) for the matches */
function design(matches, ctx) {
  const index = new Map();
  const keys = [];
  const rowPtr = new Int32Array(matches.length + 1);
  const cols = [];
  const vals = [];
  const y = new Float64Array(matches.length);
  matches.forEach((m, r) => {
    for (const [key, v] of features(m, ctx)) {
      let col = index.get(key);
      if (col === undefined) {
        col = keys.length;
        index.set(key, col);
        keys.push(key);
      }
      cols.push(col);
      vals.push(v);
    }
    rowPtr[r + 1] = cols.length;
    y[r] = m.w;
  });
  return { keys, rowPtr, cols: Int32Array.from(cols), vals: Float32Array.from(vals), y };
}

function lambdasFor(keys, { c, pair }) {
  const lam = new Float64Array(keys.length);
  keys.forEach((k, i) => {
    const g = groupOf(k);
    lam[i] = g === 'c' ? c : g === 's' || g === 'v' ? pair : FIXED_LAMBDA[g];
  });
  return lam;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Full-batch Adam on rows; returns { w, bias } */
function fit(X, rows, lam, { iters = 150, lr = 0.05 } = {}) {
  const F = X.keys.length;
  const w = new Float64Array(F);
  const grad = new Float64Array(F);
  const m = new Float64Array(F);
  const v = new Float64Array(F);
  let bias = 0;
  let mb = 0;
  let vb = 0;
  const b1 = 0.9;
  const b2 = 0.999;
  const n = rows.length;

  for (let t = 1; t <= iters; t++) {
    grad.fill(0);
    let gb = 0;
    for (const r of rows) {
      let z = bias;
      for (let k = X.rowPtr[r]; k < X.rowPtr[r + 1]; k++) z += w[X.cols[k]] * X.vals[k];
      const g = sigmoid(z) - X.y[r];
      gb += g;
      for (let k = X.rowPtr[r]; k < X.rowPtr[r + 1]; k++) grad[X.cols[k]] += g * X.vals[k];
    }
    const c1 = 1 - b1 ** t;
    const c2 = 1 - b2 ** t;
    for (let i = 0; i < F; i++) {
      const g = grad[i] / n + lam[i] * w[i];
      m[i] = b1 * m[i] + (1 - b1) * g;
      v[i] = b2 * v[i] + (1 - b2) * g * g;
      w[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + 1e-8);
    }
    gb /= n;
    mb = b1 * mb + (1 - b1) * gb;
    vb = b2 * vb + (1 - b2) * gb * gb;
    bias -= (lr * (mb / c1)) / (Math.sqrt(vb / c2) + 1e-8);
  }
  return { w, bias };
}

function evaluate(X, rows, { w, bias }) {
  let loss = 0;
  let hits = 0;
  for (const r of rows) {
    let z = bias;
    for (let k = X.rowPtr[r]; k < X.rowPtr[r + 1]; k++) z += w[X.cols[k]] * X.vals[k];
    const p = Math.min(Math.max(sigmoid(z), 1e-9), 1 - 1e-9);
    loss -= X.y[r] ? Math.log(p) : Math.log(1 - p);
    if ((p >= 0.5) === (X.y[r] === 1)) hits++;
  }
  return { logloss: loss / rows.length, accuracy: hits / rows.length };
}

// Deterministic 10% holdout by match id
function isHoldout(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 10 === 0;
}

/**
 * @returns {{ keys:string[], w:Float64Array, bias:number, lambdas:{c:number,pair:number},
 *   metrics:{ accuracy:number, logloss:number, baseLogloss:number, trainMatches:number, holdoutMatches:number } }}
 */
function train(matches, ctx, { grid = DEFAULT_GRID, refine = true, iters, maxTuneRows = 80000, log = () => {} } = {}) {
  const X = design(matches, ctx);
  const all = matches.map((_, i) => i);
  const holdout = all.filter((i) => isHoldout(matches[i].id));
  const trainRows = all.filter((i) => !isHoldout(matches[i].id));
  const tuneRows = trainRows.length > maxTuneRows ? trainRows.filter((_, i) => i % Math.ceil(trainRows.length / maxTuneRows) === 0) : trainRows;

  const blueRate = trainRows.reduce((a, r) => a + X.y[r], 0) / trainRows.length;
  const baseLogloss = -holdout.reduce((a, r) => a + (X.y[r] ? Math.log(blueRate) : Math.log(1 - blueRate)), 0) / holdout.length;

  let best = null;
  const tried = new Set();
  const search = (cs, pairs, steps, label) => {
    for (const c of cs) {
      for (const pair of pairs) {
        const key = `${c.toPrecision(3)}:${pair.toPrecision(3)}`;
        if (tried.has(key)) continue;
        tried.add(key);
        const model = fit(X, tuneRows, lambdasFor(X.keys, { c, pair }), { iters: iters || steps });
        const score = evaluate(X, holdout, model);
        log(`  ${label} c=${c.toPrecision(2)} pair=${pair.toPrecision(2)}: logloss ${score.logloss.toFixed(5)} accuracy ${(score.accuracy * 100).toFixed(2)}%`);
        if (!best || score.logloss < best.score.logloss) best = { c, pair, score };
      }
    }
  };
  search(grid.c, grid.pair, STEPS.coarse, 'coarse');
  if (refine) {
    const { c, pair } = best;
    search(FINE.map((f) => c * f), FINE.map((f) => pair * f), STEPS.fine, 'fine');
  }

  const lambdas = { c: best.c, pair: best.pair };
  const final = fit(X, all, lambdasFor(X.keys, lambdas), { iters: iters || STEPS.final });
  return {
    keys: X.keys,
    w: final.w,
    bias: final.bias,
    lambdas,
    metrics: {
      accuracy: best.score.accuracy,
      logloss: best.score.logloss,
      baseLogloss,
      trainMatches: trainRows.length,
      holdoutMatches: holdout.length,
    },
  };
}

module.exports = { train, fit, design, evaluate, isHoldout, GROUPS };
