// Recommendation engine.
//
//   score = clamp(M + Synergy + Matchup, 0, 100)
//
//   M         the champion's meta score in the role (0-100, average over sources)
//   Synergy   = SYNERGY_MAX × tanh(Σ s / SYNERGY_SOFTNESS)
//             s: synergy strength with each locked ally (0..1; 1 = +5 win-rate points)
//   Matchup   = MATCHUP_MAX × tanh(Σ w·m / MATCHUP_SOFTNESS)
//             m: strength against each locked enemy (-1..1; 1 = ±6 win-rate points)
//             w: lane opponent 1, others 0.4
//
// Calibration: in the meta score one win-rate point is worth about 3 score points
// (12 points per standard deviation, 0.6 weight, ~2.5 points of win-rate spread).
// The softness values give synergy and matchups the same exchange rate for small
// effects: a +1.5 point synergy adds ~4, a lane counter worth 6 points adds ~16.
//
// Strengths arrive already adjusted for sample size by the producer
// (collector/src/riot/score.js); they are not shrunk again here.
//
// tanh saturates the effect: three good allies cannot inflate the score without
// limit. Synergy adds at most +SYNERGY_MAX, Matchup at most ±MATCHUP_MAX.
//
// Exposed as window.Recommend in the browser and module.exports in Node (tests).

(function (root) {
  const SYNERGY_MAX = 15;
  const MATCHUP_MAX = 20;
  const SYNERGY_SOFTNESS = 1.0;
  const MATCHUP_SOFTNESS = 0.9;
  const LANE_WEIGHT = 1;
  const OTHER_WEIGHT = 0.4;
  const OFF_ROLE_PENALTY = 30; // a champion with no data in the slot's role is treated as off-role

  // If several sources give the same key, they are averaged
  function averager() {
    const m = new Map();
    return {
      add(key, v) {
        const p = m.get(key);
        m.set(key, p ? { s: p.s + v, n: p.n + 1 } : { s: v, n: 1 });
      },
      get: (key) => {
        const p = m.get(key);
        return p ? p.s / p.n : null;
      },
      keys: () => m.keys(),
    };
  }

  const indexCache = new WeakMap();
  function buildIndex(stats) {
    if (indexCache.has(stats)) return indexCache.get(stats);
    const meta = averager();
    const syn = averager(); // champ:role:ally
    const synRev = averager(); // ally:champ (any role) -> estimate from the other direction
    const mu = averager(); // champ:role:opp
    const muRev = averager(); // opp:champ -> the opponent's strength against us

    for (const r of stats.meta || []) meta.add(`${r.champion_id}:${r.role}`, Number(r.score));
    for (const r of stats.synergy || []) {
      const v = Number(r.strength);
      syn.add(`${r.champion_id}:${r.role}:${r.ally_id}`, v);
      synRev.add(`${r.ally_id}:${r.champion_id}`, v);
    }
    for (const r of stats.matchup || []) {
      const v = Number(r.strength);
      mu.add(`${r.champion_id}:${r.role}:${r.opponent_id}`, v);
      muRev.add(`${r.opponent_id}:${r.champion_id}`, v);
    }

    const byRole = new Map(); // role -> [{id, score}]
    const bestRole = new Map(); // champ -> its highest scoring role
    for (const key of meta.keys()) {
      const [id, role] = key.split(':');
      const championId = Number(id);
      const score = meta.get(key);
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push({ championId, score });
      const b = bestRole.get(championId);
      if (!b || b.score < score) bestRole.set(championId, { role, score });
    }

    const idx = {
      hasMeta: bestRole.size > 0,
      byRole,
      bestRole,
      meta: (c, role) => meta.get(`${c}:${role}`),
      // Without direct data, the ally's synergy with us is used (synergy is mostly mutual)
      synergy: (c, role, ally) => syn.get(`${c}:${role}:${ally}`) ?? synRev.get(`${c}:${ally}`),
      // Without direct data, the inverse of the opponent's strength against us is used
      matchup: (c, role, opp) => {
        const direct = mu.get(`${c}:${role}:${opp}`);
        if (direct !== null) return direct;
        const rev = muRev.get(`${c}:${opp}`);
        return rev === null ? null : -rev;
      },
    };
    indexCache.set(stats, idx);
    return idx;
  }

  // Scores one champion in a role against the current locked picks
  function scoreOne(idx, c, allies, enemies) {
    const allyHits = [];
    let synSum = 0;
    for (const a of allies) {
      if (a === c.championId) continue;
      const v = idx.synergy(c.championId, c.role, a);
      if (v === null || v <= 0) continue;
      synSum += v;
      allyHits.push({ championId: a, value: v });
    }

    const enemyHits = [];
    let muSum = 0;
    for (const e of enemies) {
      const v = idx.matchup(c.championId, c.role, e.championId);
      if (v === null || v === 0) continue;
      const lane = e.position ? e.position === c.role : idx.bestRole.get(e.championId)?.role === c.role;
      muSum += (lane ? LANE_WEIGHT : OTHER_WEIGHT) * v;
      enemyHits.push({ championId: e.championId, value: v, lane });
    }

    const synergy = SYNERGY_MAX * Math.tanh(synSum / SYNERGY_SOFTNESS);
    const matchup = MATCHUP_MAX * Math.tanh(muSum / MATCHUP_SOFTNESS);
    return {
      championId: c.championId,
      role: c.role,
      base: Math.round(c.score),
      synergy: Math.round(synergy),
      matchup: Math.round(matchup),
      score: Math.round(Math.min(100, Math.max(0, c.score + synergy + matchup))),
      allies: allyHits.sort((x, y) => y.value - x.value),
      enemies: enemyHits.sort((x, y) => Math.abs(y.value) - Math.abs(x.value)),
    };
  }

  /**
   * @param {object} p
   * @param {{meta:object[], synergy:object[], matchup:object[]}} p.stats
   * @param {string} [p.role]                 our role (empty = each champion in its best role)
   * @param {Set<number>} [p.unavailable]     banned / picked
   * @param {Iterable<number>|null} [p.pickable]  pickable champions (LCU); null = no restriction
   * @param {number[]} [p.allies]             champions locked on our team
   * @param {Array<{championId:number, position?:string}>} [p.enemies]  locked on the enemy team
   * @param {Iterable<number>} [p.pool]       the player's pool (marked only, does not change the score)
   * @param {number} [p.limit]
   * @returns {Array<{championId, role, score, base, synergy, matchup,
   *   allies:{championId,value}[], enemies:{championId,value}[], inPool:boolean}>}
   */
  function recommend({ stats, role = '', unavailable = new Set(), pickable = null, allies = [], enemies = [], pool = [], limit = 10 }) {
    const idx = buildIndex(stats || {});
    if (!idx.hasMeta) return [];
    const allowed = pickable ? new Set(pickable) : null;
    const inPool = new Set(pool);

    const candidates = role
      ? (idx.byRole.get(role) || []).map((c) => ({ ...c, role }))
      : [...idx.bestRole].map(([championId, b]) => ({ championId, score: b.score, role: b.role }));

    const out = [];
    for (const c of candidates) {
      if (unavailable.has(c.championId) || (allowed && !allowed.has(c.championId))) continue;
      out.push({ ...scoreOne(idx, c, allies, enemies), inPool: inPool.has(c.championId) });
    }
    return out.sort((a, b) => b.score - a.score || b.base - a.base).slice(0, limit);
  }

  /**
   * Scores a single champion, e.g. one a player has hovered or locked.
   * With a known role and no data for the champion there, it is off-role: its best
   * role's score minus OFF_ROLE_PENALTY. Without a role (enemies), its best role is used.
   * Returns null when there is no meta data for the champion at all.
   */
  function evaluate({ stats, championId, role = '', allies = [], enemies = [] }) {
    const idx = buildIndex(stats || {});
    const best = idx.bestRole.get(championId);
    if (!best) return null;
    const inRole = role ? idx.meta(championId, role) : null;
    if (inRole !== null) return { ...scoreOne(idx, { championId, role, score: inRole }, allies, enemies), offRole: false };
    if (!role) return { ...scoreOne(idx, { championId, role: best.role, score: best.score }, allies, enemies), offRole: false };
    const score = Math.max(0, best.score - OFF_ROLE_PENALTY);
    return { ...scoreOne(idx, { championId, role, score }, allies, enemies), offRole: true };
  }

  const api = { recommend, evaluate, SYNERGY_MAX, MATCHUP_MAX };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Recommend = api;
})(typeof window !== 'undefined' ? window : globalThis);
