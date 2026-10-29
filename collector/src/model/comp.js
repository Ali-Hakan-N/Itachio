// Team composition: styles learned from the matches, at team level. Pure functions.
//
// The other layers see single champions and pairs. A composition is more than its pairs:
// a team needs some front line, some engage, a mix of damage, and a plan (front to back,
// poke, pick, dive) that works against the other team's. Nobody labels champions here.
// Every champion gets K style numbers u_c, learned; a team's style is their sum
//   T = u_1 + ... + u_5
// and the composition term of a match, seen from blue, is
//   Σ_k a_k × (tanh(Tb_k + c_k) - tanh(Tr_k + c_k))  +  Tbᵀ M Tr
// tanh saturates, so a style can matter a lot from none to one champion and little from
// two to three; M is antisymmetric (style against style: Tᵀ M T' = -T'ᵀ M T). The data
// decides what the K directions mean (engage, poke, front line ...); the champions
// highest on each are logged after training.
//
// It is fitted on top of the rest of the model (offset = the model's calibrated
// cross-validated logits) by full-batch Adam. It starts at exactly zero (a = 0, M = 0,
// small random u) and only grows where the data asks for it; an L2 penalty on all of it
// and the number of iterations (early stopping) are chosen on held-out matches. Its
// cross-validated gain over the model without it is measured like every layer's.

const K = 4;
const MAX_ITERS = 400;
const CHECK_EVERY = 25; // iterations between validation checks while tuning
const PATIENCE = 100; // tuning stops after this many iterations without a better validation loss
const TUNE_ROWS = 25000; // tuning fits on at most this many matches (evenly spread)
const LR = 0.02;
const TAU_GRID = [30, 300, 3000]; // L2 penalty in pseudo-games

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Champion index of the matches: { ids, of: Map id -> index, teams: Int32Array(rows*10) } */
function champions(matches) {
  const of = new Map();
  const ids = [];
  const teams = new Int32Array(matches.length * 10);
  matches.forEach((m, r) => {
    [...m.b, ...m.r].forEach((c, i) => {
      if (!of.has(c)) {
        of.set(c, ids.length);
        ids.push(c);
      }
      teams[r * 10 + i] = of.get(c);
    });
  });
  return { ids, of, teams };
}

// Antisymmetric M from its upper triangle m (K(K-1)/2 numbers)
function matrix(m) {
  const M = Array.from({ length: K }, () => new Float64Array(K));
  let n = 0;
  for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
      M[i][j] = m[n];
      M[j][i] = -m[n];
      n++;
    }
  }
  return M;
}

/** Composition term of row r (blue's view); fills the team styles Tb, Tr (buffers) */
function term(p, idx, r, M = matrix(p.m), Tb = new Float64Array(K), Tr = new Float64Array(K)) {
  Tb.fill(0);
  Tr.fill(0);
  for (let i = 0; i < 5; i++) {
    const b = idx.teams[r * 10 + i] * K;
    const q = idx.teams[r * 10 + 5 + i] * K;
    for (let k = 0; k < K; k++) {
      Tb[k] += p.U[b + k];
      Tr[k] += p.U[q + k];
    }
  }
  let z = 0;
  for (let k = 0; k < K; k++) {
    z += p.a[k] * (Math.tanh(Tb[k] + p.c[k]) - Math.tanh(Tr[k] + p.c[k]));
    for (let j = 0; j < K; j++) z += Tb[k] * M[k][j] * Tr[j];
  }
  return z;
}

/**
 * Fits the composition term on rows, on top of offset (logits of the rest of the model).
 * onCheck(p, iteration) is called every CHECK_EVERY iterations (for early stopping).
 */
function fit(idx, y, offset, rows, { tau, iters = MAX_ITERS, seed = 7, onCheck = null }) {
  // onCheck may return false to stop early
  const rand = seeded(seed);
  const nm = (K * (K - 1)) / 2;
  const p = {
    U: Float64Array.from({ length: idx.ids.length * K }, () => rand() * 0.3),
    a: new Float64Array(K),
    c: new Float64Array(K),
    m: new Float64Array(nm),
  };
  const n = rows.length;
  const lam = tau / n;
  const names = ['U', 'a', 'c', 'm'];
  const mom = Object.fromEntries(names.map((k) => [k, new Float64Array(p[k].length)]));
  const vel = Object.fromEntries(names.map((k) => [k, new Float64Array(p[k].length)]));
  const Tb = new Float64Array(K);
  const Tr = new Float64Array(K);
  const dTb = new Float64Array(K);
  const dTr = new Float64Array(K);
  for (let t = 1; t <= iters; t++) {
    const g = Object.fromEntries(names.map((k) => [k, new Float64Array(p[k].length)]));
    const M = matrix(p.m);
    for (const r of rows) {
      const z = term(p, idx, r, M, Tb, Tr);
      const e = (sigmoid(offset[r] + z) - y[r]) / n; // dLoss/dz
      for (let k = 0; k < K; k++) {
        const tb = Math.tanh(Tb[k] + p.c[k]);
        const tr = Math.tanh(Tr[k] + p.c[k]);
        const sb = 1 - tb * tb;
        const sr = 1 - tr * tr;
        g.a[k] += e * (tb - tr);
        g.c[k] += e * p.a[k] * (sb - sr);
        let mTr = 0;
        let mTb = 0;
        for (let j = 0; j < K; j++) {
          mTr += M[k][j] * Tr[j];
          mTb += M[j][k] * Tb[j];
        }
        dTb[k] = p.a[k] * sb + mTr;
        dTr[k] = -p.a[k] * sr + mTb;
      }
      let n2 = 0;
      for (let i = 0; i < K; i++) {
        for (let j = i + 1; j < K; j++) {
          g.m[n2] += e * (Tb[i] * Tr[j] - Tb[j] * Tr[i]);
          n2++;
        }
      }
      for (let i = 0; i < 5; i++) {
        const b = idx.teams[r * 10 + i] * K;
        const q = idx.teams[r * 10 + 5 + i] * K;
        for (let k = 0; k < K; k++) {
          g.U[b + k] += e * dTb[k];
          g.U[q + k] += e * dTr[k];
        }
      }
    }
    for (const k of ['U', 'a', 'm']) for (let i = 0; i < p[k].length; i++) g[k][i] += lam * p[k][i];
    for (const k of names) {
      const x = p[k];
      for (let i = 0; i < x.length; i++) {
        mom[k][i] = 0.9 * mom[k][i] + 0.1 * g[k][i];
        vel[k][i] = 0.999 * vel[k][i] + 0.001 * g[k][i] * g[k][i];
        const mh = mom[k][i] / (1 - 0.9 ** t);
        const vh = vel[k][i] / (1 - 0.999 ** t);
        x[i] -= (LR * mh) / (Math.sqrt(vh) + 1e-8);
      }
    }
    if (onCheck && t % CHECK_EVERY === 0 && onCheck(p, t) === false) break;
  }
  return p;
}

const lossOf = (z, y) => -Math.log(Math.min(Math.max(y ? sigmoid(z) : 1 - sigmoid(z), 1e-9), 1 - 1e-9));

/**
 * The composition layer: penalty tuned on fold 0, cross-validated logits, final fit.
 * offset: calibrated cross-validated logits of the rest of the model.
 * Returns { params, z (cross-validated logits with composition), tau, styles }.
 */
function compLayer(matches, y, offset, fold, folds, log = () => {}) {
  const idx = champions(matches);
  const rows = matches.map((_, i) => i);
  const all0 = rows.filter((r) => fold[r] !== 0);
  const every = Math.max(1, all0.length / TUNE_ROWS);
  const train0 = all0.length > TUNE_ROWS ? Array.from({ length: TUNE_ROWS }, (_, i) => all0[Math.floor(i * every)]) : all0;
  const valid0 = rows.filter((r) => fold[r] === 0);
  const validLoss = (p) => {
    const M = matrix(p.m);
    let loss = 0;
    for (const r of valid0) loss += lossOf(offset[r] + term(p, idx, r, M), y[r]);
    return loss / valid0.length;
  };
  // Penalty and iterations on fold 0; 0 iterations (no composition) is a candidate too
  let best = { tau: TAU_GRID[0], iters: 0, loss: valid0.reduce((a, r) => a + lossOf(offset[r], y[r]), 0) / valid0.length };
  for (const tau of TAU_GRID) {
    let tauBest = null;
    fit(idx, y, offset, train0, {
      tau,
      onCheck: (p, t) => {
        const loss = validLoss(p);
        if (!tauBest || loss < tauBest.loss) tauBest = { tau, iters: t, loss };
        return t - tauBest.iters < PATIENCE;
      },
    });
    log(`  composition tau ${tau}: validation logloss ${tauBest.loss.toFixed(5)} at ${tauBest.iters} iterations`);
    if (tauBest.loss < best.loss) best = tauBest;
  }
  const z = Float64Array.from(offset);
  if (best.iters) {
    for (let f = 0; f < folds; f++) {
      const train = rows.filter((r) => fold[r] !== f);
      const p = fit(idx, y, offset, train, { tau: best.tau, iters: best.iters });
      const M = matrix(p.m);
      for (const r of rows) if (fold[r] === f) z[r] = offset[r] + term(p, idx, r, M);
    }
  }
  const params = fit(idx, y, offset, rows, { tau: best.tau, iters: best.iters });
  return { params, idx, z, tau: best.tau, iters: best.iters };
}

/**
 * For the export: { k, U: { "<champ>": [K numbers] }, a, c, m } and, per style, the
 * champions highest on it (to see what the data found).
 */
function exportComp({ params, idx }, round = (v) => Math.round(v * 1e4) / 1e4) {
  const U = {};
  idx.ids.forEach((c, i) => {
    U[c] = Array.from(params.U.subarray(i * K, i * K + K), round);
  });
  const styles = [];
  for (let k = 0; k < K; k++) {
    const ranked = idx.ids.map((c, i) => [c, params.U[i * K + k]]).sort((x, y) => y[1] - x[1]);
    styles.push({ weight: round(params.a[k]), top: ranked.slice(0, 6).map(([c]) => c), bottom: ranked.slice(-6).map(([c]) => c) });
  }
  return { comp: { k: K, U, a: Array.from(params.a, round), c: Array.from(params.c, round), m: Array.from(params.m, round) }, styles };
}

module.exports = { compLayer, exportComp, champions, term, fit, matrix, K };
