// Win model for "does blue win", trained on single matches and built up in layers:
//
//   strength       champion strength per role + learned off-role term
//   synergy        a weight for every same-team pair (champion:role × champion:role)
//                  and for every class pair (Mage + Tank ...)
//   matchup        a weight for every enemy pair, and for class against class
//   latent pairs   factorization machine: every champion:role gets small vectors and
//                  pair effects come from their dot products, so pairs seen rarely or
//                  never still get an estimate from similar champions
//
// Each layer must prove itself: it is kept only if 5-fold cross-validated predictions
// improve on the model without it by more than ACCEPT_SE standard errors (paired over
// matches). A rejected layer is left out of the model entirely.
//
// Regularization is set in pseudo-games (tau): a weight needs about tau matches of
// evidence before it moves freely, so it shrinks less as data grows (the penalty per
// match is tau / matches). Every layer's tau is searched on one validation split. Pair
// layers also try adaptive shrinkage (a second pass that shrinks strong weights less
// and weak ones more), kept only if it validates better: real effects keep their size
// while noise goes to zero.
//
// The chosen model is then calibrated (Platt scaling on the cross-validated predictions),
// fitted on all matches, and each explicit weight gets an approximate standard error
// (Laplace).
//
// train() returns { keys, w, bias, lambdas, metrics } like before, plus se, groups and fm.

const { features, groupOf } = require('./features');

const GROUP_CODE = { c: 0, o: 1, s: 2, ts: 3, v: 4, tv: 5 };
const CODE_GROUP = Object.fromEntries(Object.entries(GROUP_CODE).map(([g, c]) => [c, g]));
// Grids are tau in pseudo-games
const LAYERS = [
  { name: 'strength', groups: ['c', 'o'], tune: 'c', grid: [3, 10, 30, 100, 300] },
  { name: 'synergy', groups: ['s', 'ts'], tune: 's', grid: [10, 30, 100, 300, 1000, 3000], adaptive: true },
  { name: 'matchup', groups: ['v', 'tv'], tune: 'v', grid: [10, 30, 100, 300, 1000, 3000], adaptive: true },
  { name: 'latent pairs', fm: true, grid: [3, 30, 300] },
];
const FIXED_TAU = { o: 1, ts: 10, tv: 10 };
const ADAPTIVE_RANGE = [0.02, 10]; // how far adaptive shrinkage may move a weight's penalty
const ADAPTIVE_ROUNDS = 3; // reweighting passes, close to a sparse (L1-like) prior
// Playing a champion in a role it is rarely played in can't be an advantage: the data
// sets the size of that penalty, not its sign
const NON_POSITIVE = new Set(['o']);
const DEFAULTS = { folds: 5, latentDim: 6, tuneIters: 200, finalIters: 500, maxTuneRows: 60000, lr: 0.05 };
const ACCEPT_SE = 2;

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const clampP = (p) => Math.min(Math.max(p, 1e-9), 1 - 1e-9);
const lossOf = (z, y) => -Math.log(clampP(y ? sigmoid(z) : 1 - sigmoid(z)));

function hash(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Sparse design matrix (CSR) plus the 10 champion:role entities of every match */
function design(matches, ctx, folds = DEFAULTS.folds) {
  const index = new Map();
  const keys = [];
  const groups = [];
  const rowPtr = new Int32Array(matches.length + 1);
  const cols = [];
  const vals = [];
  const y = new Float64Array(matches.length);
  const entIndex = new Map();
  const entities = [];
  const ent = new Int32Array(matches.length * 10);
  const entityOf = (c, i) => {
    const key = `${c}:${i}`;
    let e = entIndex.get(key);
    if (e === undefined) {
      e = entities.length;
      entIndex.set(key, e);
      entities.push(key);
    }
    return e;
  };
  matches.forEach((m, r) => {
    for (const [key, v] of features(m, ctx)) {
      let col = index.get(key);
      if (col === undefined) {
        col = keys.length;
        index.set(key, col);
        keys.push(key);
        groups.push(GROUP_CODE[groupOf(key)]);
      }
      cols.push(col);
      vals.push(v);
    }
    rowPtr[r + 1] = cols.length;
    y[r] = m.w;
    for (let i = 0; i < 5; i++) {
      ent[r * 10 + i] = entityOf(m.b[i], i);
      ent[r * 10 + 5 + i] = entityOf(m.r[i], i);
    }
  });
  return {
    keys, groups: Uint8Array.from(groups), rowPtr, cols: Int32Array.from(cols), vals: Float32Array.from(vals), y,
    ent, entities, fold: Uint8Array.from(matches, (m) => hash(m.id) % folds),
  };
}

// Which columns a configuration uses, with their per-match penalties (tau / n)
function columnsFor(D, cfg, n = 1, scale = null) {
  const F = D.keys.length;
  const on = new Uint8Array(F);
  const lam = new Float64Array(F);
  const capped = new Uint8Array(F);
  for (let i = 0; i < F; i++) {
    const g = CODE_GROUP[D.groups[i]];
    if (!cfg.groups.has(g)) continue;
    on[i] = 1;
    lam[i] = (cfg.tau[g] / n) * (scale ? scale[i] : 1);
    capped[i] = NON_POSITIVE.has(g) ? 1 : 0;
  }
  return { on, lam, capped };
}

// Adaptive shrinkage: a weight's penalty scales with (typical size / its size) in its group
function adaptiveScale(D, cfg, w) {
  const scale = new Float64Array(D.keys.length).fill(1);
  for (const g of cfg.adaptive || []) {
    const code = GROUP_CODE[g];
    let sum = 0;
    let n = 0;
    for (let i = 0; i < w.length; i++) {
      if (D.groups[i] === code) {
        sum += Math.abs(w[i]);
        n++;
      }
    }
    const typical = n ? sum / n : 0;
    if (!typical) continue;
    for (let i = 0; i < w.length; i++) {
      if (D.groups[i] !== code) continue;
      scale[i] = Math.min(Math.max(typical / (Math.abs(w[i]) + 1e-9), ADAPTIVE_RANGE[0]), ADAPTIVE_RANGE[1]);
    }
  }
  return scale;
}

const makeTmp = (k) => ({
  SB: new Float64Array(k), SR: new Float64Array(k), PB: new Float64Array(k),
  QB: new Float64Array(k), PR: new Float64Array(k), QR: new Float64Array(k),
});

// Latent pair term of one match; leaves the team sums in t for the gradient
//   synergy: Σ over same-team pairs <S_a, S_b>, blue minus red
//   matchup: Σ over blue a, red b of <P_a, Q_b> - <P_b, Q_a>
function latentTerm(D, r, k, L, t) {
  const { S, P, Q } = L;
  for (const v of Object.values(t)) v.fill(0);
  let sqB = 0;
  let sqR = 0;
  for (let i = 0; i < 10; i++) {
    const e = D.ent[r * 10 + i] * k;
    for (let d = 0; d < k; d++) {
      const s = S[e + d];
      if (i < 5) { t.SB[d] += s; t.PB[d] += P[e + d]; t.QB[d] += Q[e + d]; sqB += s * s; }
      else { t.SR[d] += s; t.PR[d] += P[e + d]; t.QR[d] += Q[e + d]; sqR += s * s; }
    }
  }
  let z = -0.5 * sqB + 0.5 * sqR;
  for (let d = 0; d < k; d++) {
    z += 0.5 * t.SB[d] * t.SB[d] - 0.5 * t.SR[d] * t.SR[d];
    z += t.PB[d] * t.QR[d] - t.PR[d] * t.QB[d];
  }
  return z;
}

function logit(D, r, params, cols, k, tmp) {
  let z = params.bias;
  for (let j = D.rowPtr[r]; j < D.rowPtr[r + 1]; j++) {
    const c = D.cols[j];
    if (cols.on[c]) z += params.w[c] * D.vals[j];
  }
  if (params.L) z += latentTerm(D, r, k, params.L, tmp);
  return z;
}

function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296 - 0.5;
  };
}

/** Full-batch Adam on the given rows; with cfg.adaptive, a second pass with adaptive shrinkage */
function fit(D, rows, cfg, opts = {}) {
  let params = fitOnce(D, rows, cfg, null, opts);
  if (!cfg.adaptive || !cfg.adaptive.size) return params;
  for (let round = 0; round < ADAPTIVE_ROUNDS; round++) {
    const scale = adaptiveScale(D, cfg, params.w);
    params = fitOnce(D, rows, cfg, scale, opts);
    params.scale = scale;
  }
  return params;
}

function fitOnce(D, rows, cfg, scale, { iters, lr = DEFAULTS.lr, seed = 1 } = {}) {
  const cols = columnsFor(D, cfg, rows.length, scale);
  const F = D.keys.length;
  const k = cfg.fm ? cfg.fm.k : 0;
  const E = D.entities.length;
  const params = { w: new Float64Array(F), bias: 0, L: null };
  const gw = new Float64Array(F);
  const mw = new Float64Array(F);
  const vw = new Float64Array(F);
  let mb = 0;
  let vb = 0;
  let lat = null;
  if (k) {
    const rand = seeded(seed);
    const init = () => Float64Array.from({ length: E * k }, () => rand() * 0.02);
    params.L = { S: init(), P: init(), Q: init() };
    lat = ['S', 'P', 'Q'].map((name) => ({ name, g: new Float64Array(E * k), m: new Float64Array(E * k), v: new Float64Array(E * k) }));
  }
  const tmp = makeTmp(Math.max(k, 1));
  const n = rows.length;
  const b1 = 0.9;
  const b2 = 0.999;

  for (let t = 1; t <= iters; t++) {
    gw.fill(0);
    if (lat) for (const l of lat) l.g.fill(0);
    let gb = 0;
    for (const r of rows) {
      const g = sigmoid(logit(D, r, params, cols, k, tmp)) - D.y[r];
      gb += g;
      for (let j = D.rowPtr[r]; j < D.rowPtr[r + 1]; j++) {
        const c = D.cols[j];
        if (cols.on[c]) gw[c] += g * D.vals[j];
      }
      if (lat) {
        const S = params.L.S;
        const [gS, gP, gQ] = [lat[0].g, lat[1].g, lat[2].g];
        for (let i = 0; i < 10; i++) {
          const e = D.ent[r * 10 + i] * k;
          for (let d = 0; d < k; d++) {
            if (i < 5) {
              gS[e + d] += g * (tmp.SB[d] - S[e + d]);
              gP[e + d] += g * tmp.QR[d];
              gQ[e + d] -= g * tmp.PR[d];
            } else {
              gS[e + d] -= g * (tmp.SR[d] - S[e + d]);
              gQ[e + d] += g * tmp.PB[d];
              gP[e + d] -= g * tmp.QB[d];
            }
          }
        }
      }
    }
    const c1 = 1 - b1 ** t;
    const c2 = 1 - b2 ** t;
    const step = (x, i, grad, m, v) => {
      m[i] = b1 * m[i] + (1 - b1) * grad;
      v[i] = b2 * v[i] + (1 - b2) * grad * grad;
      x[i] -= (lr * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + 1e-8);
    };
    for (let i = 0; i < F; i++) {
      if (!cols.on[i]) continue;
      step(params.w, i, gw[i] / n + cols.lam[i] * params.w[i], mw, vw);
      if (cols.capped[i] && params.w[i] > 0) params.w[i] = 0;
    }
    gb /= n;
    mb = b1 * mb + (1 - b1) * gb;
    vb = b2 * vb + (1 - b2) * gb * gb;
    params.bias -= (lr * (mb / c1)) / (Math.sqrt(vb / c2) + 1e-8);
    if (lat) {
      for (const l of lat) {
        const x = params.L[l.name];
        for (let i = 0; i < x.length; i++) step(x, i, l.g[i] / n + (cfg.fm.tau / n) * x[i], l.m, l.v);
      }
    }
  }
  return params;
}

function subsample(rows, max) {
  if (rows.length <= max) return rows;
  const every = rows.length / max;
  return Array.from({ length: max }, (_, i) => rows[Math.floor(i * every)]);
}

function predict(D, rows, params, cfg) {
  const cols = columnsFor(D, cfg);
  const k = cfg.fm ? cfg.fm.k : 0;
  const tmp = makeTmp(Math.max(k, 1));
  const z = new Float64Array(D.y.length);
  for (const r of rows) z[r] = logit(D, r, params, cols, k, tmp);
  return z;
}

// Cross-validated logits: every match predicted by a model that never saw it
function outOfFold(D, cfg, o) {
  const z = new Float64Array(D.y.length);
  for (let f = 0; f < o.folds; f++) {
    const train = subsample(o.rows.filter((r) => D.fold[r] !== f), o.maxTuneRows);
    const test = o.rows.filter((r) => D.fold[r] === f);
    const zf = predict(D, test, fit(D, train, cfg, { iters: o.tuneIters, seed: f + 1 }), cfg);
    for (const r of test) z[r] = zf[r];
  }
  return z;
}

// Baseline: always the blue win rate of the training folds
function baselineOutOfFold(D, o) {
  const z = new Float64Array(D.y.length);
  for (let f = 0; f < o.folds; f++) {
    const train = o.rows.filter((r) => D.fold[r] !== f);
    const rate = train.reduce((a, r) => a + D.y[r], 0) / train.length;
    for (const r of o.rows) if (D.fold[r] === f) z[r] = Math.log(rate / (1 - rate));
  }
  return z;
}

function summary(D, rows, z) {
  let loss = 0;
  let hits = 0;
  for (const r of rows) {
    loss += lossOf(z[r], D.y[r]);
    if ((z[r] >= 0) === (D.y[r] === 1)) hits++;
  }
  return { logloss: loss / rows.length, accuracy: hits / rows.length };
}

// Paired comparison over matches: how much b improves on a, and its standard error
function compare(D, rows, za, zb) {
  let sum = 0;
  let sq = 0;
  for (const r of rows) {
    const d = lossOf(za[r], D.y[r]) - lossOf(zb[r], D.y[r]);
    sum += d;
    sq += d * d;
  }
  const n = rows.length;
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(sq / n - mean * mean, 0));
  return { improvement: mean, se: sd / Math.sqrt(n) };
}

// Platt scaling: P = σ(a·z + b), fitted with Newton steps
function platt(D, rows, z) {
  let a = 1;
  let b = 0;
  for (let it = 0; it < 30; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const r of rows) {
      const p = sigmoid(a * z[r] + b);
      const e = p - D.y[r];
      const w = p * (1 - p);
      ga += e * z[r];
      gb += e;
      haa += w * z[r] * z[r];
      hab += w * z[r];
      hbb += w;
    }
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-12) break;
    a -= (hbb * ga - hab * gb) / det;
    b -= (haa * gb - hab * ga) / det;
  }
  return { a: Math.min(Math.max(a, 0.3), 2), b };
}

// Predicted vs actual win rate in probability bins, and the expected calibration error
function reliability(D, rows, z, bins = 10) {
  const out = Array.from({ length: bins }, () => ({ n: 0, predicted: 0, actual: 0 }));
  for (const r of rows) {
    const p = sigmoid(z[r]);
    const b = out[Math.min(bins - 1, Math.floor(p * bins))];
    b.n++;
    b.predicted += p;
    b.actual += D.y[r];
  }
  let ece = 0;
  const table = out.filter((b) => b.n).map((b) => {
    ece += (b.n / rows.length) * Math.abs(b.predicted / b.n - b.actual / b.n);
    return { n: b.n, predicted: +(b.predicted / b.n).toFixed(3), actual: +(b.actual / b.n).toFixed(3) };
  });
  return { ece, bins: table };
}

/** Approximate standard error of every explicit weight (diagonal Laplace) */
function standardErrors(D, rows, params, cfg) {
  const cols = columnsFor(D, cfg, rows.length, params.scale || null);
  const k = cfg.fm ? cfg.fm.k : 0;
  const tmp = makeTmp(Math.max(k, 1));
  const h = new Float64Array(D.keys.length);
  for (const r of rows) {
    const p = sigmoid(logit(D, r, params, cols, k, tmp));
    const w = p * (1 - p);
    for (let j = D.rowPtr[r]; j < D.rowPtr[r + 1]; j++) {
      const c = D.cols[j];
      if (cols.on[c]) h[c] += w * D.vals[j] * D.vals[j];
    }
  }
  return Float64Array.from(h, (v, i) => (cols.on[i] ? 1 / Math.sqrt(v + rows.length * cols.lam[i]) : 0));
}

function withLayer(base, layer, tau, latentDim, adaptive = false) {
  const cfg = { groups: new Set(base.groups), tau: { ...base.tau }, fm: base.fm, adaptive: new Set(base.adaptive || []) };
  if (layer.fm) cfg.fm = { k: latentDim, tau };
  else {
    for (const g of layer.groups) cfg.groups.add(g);
    cfg.tau[layer.tune] = tau;
    if (adaptive) cfg.adaptive.add(layer.tune);
  }
  return cfg;
}

/**
 * @param {object} [options]  folds, latentDim, tuneIters, finalIters, maxTuneRows, log
 * @returns {{ keys, w, bias, lambdas, metrics, se, groups:string[], fm: null|{k, entities, S, P, Q} }}
 */
function train(matches, ctx, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const log = o.log || (() => {});
  const t0 = Date.now();
  const D = design(matches, ctx, o.folds);
  const rows = matches.map((_, i) => i);
  o.rows = rows;
  // Settings are compared on two validation splits, averaged, so the choice depends less on luck
  const splits = [0, 1].map((f) => ({
    valid: rows.filter((r) => D.fold[r] === f),
    fitRows: subsample(rows.filter((r) => D.fold[r] !== f), o.maxTuneRows),
  }));

  // Picks the layer's lambda on one validation split
  const tryCfg = (cfg, label) => {
    let logloss = 0;
    for (const { valid, fitRows } of splits) {
      const z = predict(D, valid, fit(D, fitRows, cfg, { iters: o.tuneIters }), cfg);
      logloss += summary(D, valid, z).logloss / splits.length;
    }
    log(`  ${label}: validation logloss ${logloss.toFixed(5)}`);
    return { cfg, logloss };
  };
  const tuneLayer = (base, layer) => {
    let best = null;
    for (const tau of layer.grid) {
      const r = tryCfg(withLayer(base, layer, tau, o.latentDim), `${layer.name} tau ${tau}`);
      if (!best || r.logloss < best.logloss) best = { ...r, tau };
    }
    // Adaptive shrinkage works with a stronger base penalty: most pairs are pushed to zero
    // and the few with real evidence get their penalty lowered
    if (layer.adaptive) {
      for (const tau of [best.tau, best.tau * 3, best.tau * 10]) {
        const r = tryCfg(withLayer(base, layer, tau, o.latentDim, true), `${layer.name} tau ${+tau.toFixed(1)} adaptive`);
        if (r.logloss < best.logloss) best = { ...r, tau };
      }
    }
    return best.cfg;
  };

  const zBase = baselineOutOfFold(D, o);
  const baseline = summary(D, rows, zBase);
  const layers = [];

  let current = tuneLayer({ groups: new Set(), tau: { ...FIXED_TAU }, fm: null, adaptive: new Set() }, LAYERS[0]);
  let zCurrent = outOfFold(D, current, o);
  const vsBase = compare(D, rows, zBase, zCurrent);
  layers.push({ name: 'strength', ...summary(D, rows, zCurrent), ...vsBase, accepted: true });
  log(`model: strength      gain ${(vsBase.improvement * 1000).toFixed(2)} ± ${(vsBase.se * 1000).toFixed(2)} ×1e-3 over always-50%`);

  for (const layer of LAYERS.slice(1)) {
    const candidate = tuneLayer(current, layer);
    const zCand = outOfFold(D, candidate, o);
    const c = compare(D, rows, zCurrent, zCand);
    const accepted = c.improvement > ACCEPT_SE * c.se;
    layers.push({ name: layer.name, ...summary(D, rows, zCand), ...c, accepted });
    log(`model: ${layer.name.padEnd(13)} gain ${(c.improvement * 1000).toFixed(2)} ± ${(c.se * 1000).toFixed(2)} ×1e-3 → ${accepted ? 'kept' : 'left out (not proven)'}`);
    if (accepted) {
      current = candidate;
      zCurrent = zCand;
    }
  }

  const cv = summary(D, rows, zCurrent);
  const cal = platt(D, rows, zCurrent);
  const before = reliability(D, rows, zCurrent);
  const after = reliability(D, rows, Float64Array.from(zCurrent, (z) => cal.a * z + cal.b));

  const params = fit(D, rows, current, { iters: o.finalIters });
  const se = standardErrors(D, rows, params, current);
  // Calibration goes into every weight, so the app's scores are calibrated too
  for (let i = 0; i < params.w.length; i++) params.w[i] *= cal.a;
  for (let i = 0; i < se.length; i++) se[i] *= cal.a;
  params.bias = cal.a * params.bias + cal.b;
  let fm = null;
  if (params.L) {
    const sa = Math.sqrt(cal.a);
    for (const name of ['S', 'P', 'Q']) for (let i = 0; i < params.L[name].length; i++) params.L[name][i] *= sa;
    fm = { k: current.fm.k, entities: D.entities, ...params.L };
  }

  const n = rows.length;
  const accuracyCI = 1.96 * Math.sqrt((cv.accuracy * (1 - cv.accuracy)) / n);
  const metrics = {
    matches: n,
    folds: o.folds,
    accuracy: cv.accuracy,
    accuracyCI,
    logloss: cv.logloss,
    baseLogloss: baseline.logloss,
    layers,
    calibration: { a: cal.a, b: cal.b, eceBefore: before.ece, eceAfter: after.ece, bins: after.bins },
    trainSeconds: Math.round((Date.now() - t0) / 1000),
    trainMatches: n, // kept for older readers
    holdoutMatches: n,
  };
  log(
    `model: cv accuracy ${(cv.accuracy * 100).toFixed(2)}% ± ${(accuracyCI * 100).toFixed(2)}, logloss ${cv.logloss.toFixed(5)} ` +
      `(always-50% ${baseline.logloss.toFixed(5)}), calibration error ${(before.ece * 100).toFixed(2)}% → ${(after.ece * 100).toFixed(2)}%`,
  );

  return {
    keys: D.keys,
    w: params.w,
    bias: params.bias,
    lambdas: { tau: { ...current.tau, fm: current.fm ? current.fm.tau : null }, adaptive: [...current.adaptive] },
    metrics,
    se,
    groups: [...current.groups],
    fm,
  };
}

module.exports = { train, fit, design, predict, LAYERS };
