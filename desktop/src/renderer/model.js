// Scores from the learned win model (trained by the collector, collector/src/model).
//
//   logit(champion) = strength(champion, role) + off-role(role) × -ln(share in role)
//                   + Σ synergy with each ally + Σ matchup against each enemy
//                   + class-pair terms (so unseen pairs still have a small effect)
//   score = 50 + 50 × tanh(pointsPerLogit × (logit - center) / 50)
//
// The scale is fixed per model, not per draft: 50 is an average champion, and
// tanh keeps scores off 0 and 100. Every weight comes from the data; a champion
// rarely played in a role scores low because the model learned the off-role term.
//
// Engine picks this model when the app has one and falls back to the older
// recommend.js otherwise. Exposed as window.Engine in the browser and as
// module.exports in Node (tests).

(function (root) {
  const ROLES = ['top', 'jungle', 'middle', 'bottom', 'utility'];
  const ROLE_INDEX = Object.fromEntries(ROLES.map((r, i) => [r, i]));
  const OFF_ROLE_SHARE = 0.05; // below this share a pick is marked off-role

  const cache = new WeakMap();
  function index(model) {
    if (cache.has(model)) return cache.get(model);
    const champ = new Map();
    const bestRole = new Map();
    for (const [key, [w, games, share]] of Object.entries(model.champ || {})) {
      champ.set(key, { w, games, share });
      const [c, r] = key.split(':').map(Number);
      const b = bestRole.get(c);
      if (!b || b.games < games) bestRole.set(c, { r, games });
    }
    const pair = (list, anti) => {
      const m = new Map();
      for (const [a, ra, b, rb, w] of list || []) {
        m.set(`${a}:${ra}:${b}:${rb}`, w);
        m.set(`${b}:${rb}:${a}:${ra}`, anti ? -w : w);
      }
      return m;
    };
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
      ts: classPair(model.ts, false),
      tv: classPair(model.tv, true),
      tags: new Map(Object.entries(model.tags || {}).map(([id, t]) => [Number(id), t])),
      off: model.off || [0, 0, 0, 0, 0],
      floor: model.shareFloor || 0.002,
      K: model.pointsPerLogit || 75,
      center: model.center || 0,
    };
    cache.set(model, ix);
    return ix;
  }

  const has = (model) => !!model && !!model.champ && Object.keys(model.champ).length > 0;
  const roleIndex = (ix, championId, position) =>
    position && ROLE_INDEX[position] !== undefined ? ROLE_INDEX[position] : ix.bestRole.get(championId)?.r ?? null;
  const toScore = (ix, x) => 50 + 50 * Math.tanh((ix.K * x) / 50);

  // A player on the board: { championId, position? } or a bare champion id
  const asPick = (p) => (typeof p === 'number' ? { championId: p, position: '' } : p);

  function scoreOne(ix, championId, r, allies, enemies) {
    const e = ix.champ.get(`${championId}:${r}`);
    const share = e ? e.share : 0;
    const base = (e ? e.w : 0) + ix.off[r] * -Math.log(Math.max(share, ix.floor)) - ix.center;
    const tag = ix.tags.get(championId) || 'None';

    let syn = 0;
    const allyHits = [];
    for (const p of allies.map(asPick)) {
      if (p.championId === championId) continue;
      const ra = roleIndex(ix, p.championId, p.position);
      const v = (ra === null ? 0 : ix.syn.get(`${championId}:${r}:${p.championId}:${ra}`) || 0) +
        (ix.ts.get(`${tag}:${ix.tags.get(p.championId) || 'None'}`) || 0);
      syn += v;
      if (v) allyHits.push({ championId: p.championId, value: v });
    }

    let mu = 0;
    const enemyHits = [];
    for (const p of enemies.map(asPick)) {
      const re = roleIndex(ix, p.championId, p.position);
      const v = (re === null ? 0 : ix.vs.get(`${championId}:${r}:${p.championId}:${re}`) || 0) +
        (ix.tv.get(`${tag}:${ix.tags.get(p.championId) || 'None'}`) || 0);
      mu += v;
      if (v) enemyHits.push({ championId: p.championId, value: v, lane: re === r });
    }

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
