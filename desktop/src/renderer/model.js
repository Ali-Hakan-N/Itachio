// Scores from the learned win model (trained by the collector, collector/src/model).
//
//   logit(champion) = strength(champion, role) + off-role(role) × -ln(share in role)
//                   + Σ synergy with each ally + Σ matchup against each enemy
//                   + class-pair terms (so unseen pairs still have a small effect)
//                   + latent pair terms, when the training kept that layer
// Only layers the training proved (cross-validated) are in the model.
//
// Temporary pairs (synT/vsT): while the synergy or matchup layer is not proven as a
// whole, the training still exports single pairs with evidence (weight / standard error
// above 1.5). They count with the learned weight, phased in by evidence: none at 1.5
// standard errors, full from TEMP_FULL_Z, so pairs entering or leaving between trainings
// never jump. Each pair is capped at TEMP_PAIR and all of them together at TEMP_TOTAL
// standard deviations of strength (on the display scale about 9 and 20 points). Pairs
// in any roles count, not only lane opponents. They disappear by themselves once the
// training proves the layer.
//
// Display scale: logits are measured against the model's own spread of champion
// strength (well-played champion:role pairs), so scores use the whole 0-100 range
// however small the learned effects are:
//   z     = (logit - mean strength) / standard deviation of strength
//   score = 50 + 50 × tanh(SPREAD × z)       z = 1 → 67, z = 2 → 80, z = 3 → 89
// Order and strategy are the model's; only the presentation is stretched. The scale
// is fixed per model, not per draft. Picks with few games in the data are marked unsure.
//
// Engine picks this model when the app has one and falls back to the older
// recommend.js otherwise. Exposed as window.Engine in the browser and as
// module.exports in Node (tests).

(function (root) {
  const ROLES = ['top', 'jungle', 'middle', 'bottom', 'utility'];
  const ROLE_INDEX = Object.fromEntries(ROLES.map((r, i) => [r, i]));
  const OFF_ROLE_SHARE = 0.05; // below this share a pick is marked off-role
  const SPREAD = 0.35; // how far one standard deviation of strength moves the score
  const SCALE_MIN_GAMES = 100; // champion:role pairs that define the scale
  const UNSURE_GAMES = 100; // fewer games than this in the role: rough estimate
  const TEMP_FROM_Z = 1.5; // evidence (weight / standard error) where a temporary pair starts to count
  const TEMP_FULL_Z = 2.5; // evidence from which it counts fully
  const TEMP_PAIR = 0.5; // cap of one temporary pair, in standard deviations of strength
  const TEMP_TOTAL = 1.2; // cap of all temporary synergy (and, separately, matchup) terms

  const cache = new WeakMap();
  function index(model) {
    if (cache.has(model)) return cache.get(model);
    const champ = new Map();
    const bestRole = new Map();
    for (const [key, [w, games, share, se]] of Object.entries(model.champ || {})) {
      champ.set(key, { w, games, share, se: se || 0 });
      const [c, r] = key.split(':').map(Number);
      const b = bestRole.get(c);
      if (!b || b.games < games) bestRole.set(c, { r, games });
    }
    // Pair weights as { w, se }; the reversed key flips the sign for matchups
    const pair = (list, anti) => {
      const m = new Map();
      for (const [a, ra, b, rb, w, se] of list || []) {
        m.set(`${a}:${ra}:${b}:${rb}`, { w, se: se || 0 });
        m.set(`${b}:${rb}:${a}:${ra}`, { w: anti ? -w : w, se: se || 0 });
      }
      return m;
    };
    const vectors = (obj) => new Map(Object.entries(obj || {}));
    const classPair = (obj, anti) => {
      const m = new Map();
      for (const [key, w] of Object.entries(obj || {})) {
        const [x, y] = key.split(':');
        m.set(`${x}:${y}`, w);
        m.set(`${y}:${x}`, x === y ? w : anti ? -w : w);
      }
      return m;
    };
    const ix = {
      champ,
      bestRole,
      syn: pair(model.syn, false),
      vs: pair(model.vs, true),
      synT: pair(model.synT, false),
      vsT: pair(model.vsT, true),
      ts: classPair(model.ts, false),
      tv: classPair(model.tv, true),
      tags: new Map(Object.entries(model.tags || {}).map(([id, t]) => [Number(id), t])),
      off: model.off || [0, 0, 0, 0, 0],
      floor: model.shareFloor || 0.002,
      fm: model.fm ? { S: vectors(model.fm.S), P: vectors(model.fm.P), Q: vectors(model.fm.Q) } : null,
    };
    // Scale from the spread of strength among well-played champion:role pairs
    const strengthOf = (key, e) => e.w + ix.off[Number(key.split(':')[1])] * -Math.log(Math.max(e.share, ix.floor));
    let pool = [...champ].filter(([, e]) => e.games >= SCALE_MIN_GAMES);
    if (pool.length < 10) pool = [...champ];
    const bases = pool.map(([key, e]) => strengthOf(key, e));
    ix.center = bases.length ? bases.reduce((a, b) => a + b, 0) / bases.length : 0;
    const sd = bases.length > 1 ? Math.sqrt(bases.reduce((a, b) => a + (b - ix.center) ** 2, 0) / bases.length) : 0;
    ix.sd = sd > 1e-6 ? sd : 0.08;
    cache.set(model, ix);
    return ix;
  }

  const has = (model) => !!model && !!model.champ && Object.keys(model.champ).length > 0;
  const roleIndex = (ix, championId, position) =>
    position && ROLE_INDEX[position] !== undefined ? ROLE_INDEX[position] : ix.bestRole.get(championId)?.r ?? null;
  const toScore = (ix, x) => 50 + 50 * Math.tanh((SPREAD * x) / ix.sd);

  // A player on the board: { championId, position? } or a bare champion id
  const asPick = (p) => (typeof p === 'number' ? { championId: p, position: '' } : p);

  const clamp = (v, cap) => Math.max(-cap, Math.min(cap, v));
  // Temporary pair weight, phased in by evidence and capped; 0 when the pair is not listed
  const temp = (ix, map, key) => {
    const t = map.get(key);
    if (!t) return 0;
    const z = t.se > 0 ? Math.abs(t.w) / t.se : TEMP_FULL_Z;
    const phase = Math.max(0, Math.min(1, (z - TEMP_FROM_Z) / (TEMP_FULL_Z - TEMP_FROM_Z)));
    return clamp(t.w * phase, TEMP_PAIR * ix.sd);
  };

  const dot = (a, b) => {
    if (!a || !b) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  };

  function scoreOne(ix, championId, r, allies, enemies) {
    const self = `${championId}:${r}`;
    const e = ix.champ.get(self);
    const share = e ? e.share : 0;
    const base = (e ? e.w : 0) + ix.off[r] * -Math.log(Math.max(share, ix.floor)) - ix.center;
    const tag = ix.tags.get(championId) || 'None';
    // Champions never seen in this role have no standard error: treat them as very unsure
    let variance = e ? e.se * e.se : 1;

    let syn = 0;
    let synT = 0;
    const allyHits = [];
    for (const p of allies.map(asPick)) {
      if (p.championId === championId) continue;
      const ra = roleIndex(ix, p.championId, p.position);
      const explicit = ra === null ? null : ix.syn.get(`${championId}:${r}:${p.championId}:${ra}`);
      if (explicit) variance += explicit.se * explicit.se;
      const latent = ix.fm && ra !== null ? dot(ix.fm.S.get(self), ix.fm.S.get(`${p.championId}:${ra}`)) : 0;
      const t = ra === null ? 0 : temp(ix, ix.synT, `${championId}:${r}:${p.championId}:${ra}`);
      const v = (explicit ? explicit.w : 0) + latent + (ix.ts.get(`${tag}:${ix.tags.get(p.championId) || 'None'}`) || 0);
      syn += v;
      synT += t;
      if (v + t) allyHits.push({ championId: p.championId, value: v + t });
    }
    syn += clamp(synT, TEMP_TOTAL * ix.sd);

    let mu = 0;
    let muT = 0;
    const enemyHits = [];
    for (const p of enemies.map(asPick)) {
      const re = roleIndex(ix, p.championId, p.position);
      const other = `${p.championId}:${re}`;
      const explicit = re === null ? null : ix.vs.get(`${championId}:${r}:${other}`);
      if (explicit) variance += explicit.se * explicit.se;
      const latent = ix.fm && re !== null
        ? dot(ix.fm.P.get(self), ix.fm.Q.get(other)) - dot(ix.fm.P.get(other), ix.fm.Q.get(self))
        : 0;
      const t = re === null ? 0 : temp(ix, ix.vsT, `${championId}:${r}:${other}`);
      const v = (explicit ? explicit.w : 0) + latent + (ix.tv.get(`${tag}:${ix.tags.get(p.championId) || 'None'}`) || 0);
      mu += v;
      muT += t;
      if (v + t) enemyHits.push({ championId: p.championId, value: v + t, lane: re === r });
    }
    mu += clamp(muT, TEMP_TOTAL * ix.sd);

    const score = toScore(ix, base + syn + mu);
    const baseScore = toScore(ix, base);
    return {
      championId,
      role: ROLES[r],
      base: Math.round(baseScore),
      synergy: Math.round(toScore(ix, base + syn) - baseScore),
      matchup: Math.round(score - toScore(ix, base + syn)),
      score: Math.round(score),
      offRole: share < OFF_ROLE_SHARE,
      games: e ? e.games : 0,
      uncertainty: Math.round((50 * SPREAD * Math.sqrt(variance)) / ix.sd),
      unsure: !e || e.games < UNSURE_GAMES,
      allies: allyHits.sort((a, b) => b.value - a.value),
      enemies: enemyHits.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
    };
  }

  /** Same arguments and result as Recommend.recommend, plus model */
  function recommend({ model, role = '', unavailable = new Set(), pickable = null, allies = [], enemies = [], pool = [], limit = 10 }) {
    const ix = index(model);
    const allowed = pickable ? new Set(pickable) : null;
    const inPool = new Set(pool);
    const out = [];
    for (const [championId, best] of ix.bestRole) {
      if (unavailable.has(championId) || (allowed && !allowed.has(championId))) continue;
      const r = role ? ROLE_INDEX[role] : best.r;
      out.push({ ...scoreOne(ix, championId, r, allies, enemies), inPool: inPool.has(championId) });
    }
    return out.sort((a, b) => b.score - a.score || b.games - a.games).slice(0, limit);
  }

  /** Same arguments and result as Recommend.evaluate, plus model */
  function evaluate({ model, championId, role = '', allies = [], enemies = [] }) {
    const ix = index(model);
    if (!ix.bestRole.has(championId)) return null;
    const r = role ? ROLE_INDEX[role] : ix.bestRole.get(championId).r;
    return scoreOne(ix, championId, r, allies, enemies);
  }

  // Older engine (recommend.js) takes allies as champion ids
  const legacy = (args) => ({ ...args, allies: (args.allies || []).map((p) => asPick(p).championId) });

  const Engine = {
    recommend: (args) => (has(args.model) ? recommend(args) : root.Recommend.recommend(legacy(args))),
    evaluate: (args) => (has(args.model) ? evaluate(args) : root.Recommend.evaluate(legacy(args))),
  };

  const api = { recommend, evaluate, Engine, ROLES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
