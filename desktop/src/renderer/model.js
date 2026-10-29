// Scores from the learned win model (trained by the collector, collector/src/model).
//
//   logit(champion) = strength(champion, role) + off-role(role) × -ln(share in role)
//                   + Σ synergy with each ally + Σ matchup against each enemy
//                   + class-pair terms (so unseen pairs still have a small effect)
//                   + latent pair terms
// Every layer is in the model with what the data has so far; its regularization is
// tuned on held-out matches, so weights backed by little data stay small.
//
// Early game pairs (synE/vsE): what a pair is worth in winning through the first
// minutes (lanes, first objectives), learned from that much less noisy data. They add
// to synergy and matchups like the pairs learned from results alone.
//
// Display scale: logits are measured against the model's own spread of champion
// strength (well-played champion:role pairs), so scores use the whole 0-100 range
// however small the learned effects are:
//   z     = (logit - mean strength) / standard deviation of strength
//   score = 50 + 50 × tanh(SPREAD × z)       z = 1 → 67, z = 2 → 80, z = 3 → 89
// Order and strategy are the model's; only the presentation is stretched. The scale
// is fixed per model, not per draft. Picks with few games in the data are marked unsure.
//
// Personal layer: how the player does on the champion, from their own games
// (collector/src/players): personal = { byKey: { "<champ>:<role name>": { delta, games } },
// unplayed }. delta is in log-odds and adds to the model's logit; champions the player
// has not played get unplayed. Only for players with an analysis.
//
// Composition (comp): every champion has learned style numbers u (collector comp.js); a
// team's style is their sum T, and a team gains Σ_k a_k tanh(T_k + c_k) plus Tᵀ M T_enemy
// (M antisymmetric). A candidate is worth what it adds to that for its team.
//
// The rest of the draft: while picks are still open, a candidate is also scored against
// what is likely to come. Every open slot (ours and theirs) gets a distribution over
// champions from the same choice model as the enemy's answers (popularity × exp(λ ×
// matchups against the other team)); the candidate gains its expected synergy with our
// future picks, and the composition is taken with the expected final styles of both
// teams.
//
// Uncertain strength counts less: a champion's strength in a role is scored at what the
// data supports with some confidence, its estimate minus UNCERTAINTY_Z standard errors
// beyond the role's usual (games-weighted) standard error. Rare picks (off-role, niche)
// rest on few games, mostly from players who specialize in them, so their estimates are
// both noisy and flattering; this lowers them in proportion, and less and less as their
// games add up. Champions never seen in a role are not recommended.
//
// The look-ahead terms (the rest of the draft, the enemy's answers) add up many pair
// weights; for a champion with few games in the role each of them is noisy. They count
// in proportion to the evidence: games / (games + the strength layer's prior in
// pseudo-games, tuned on held-out matches).
//
// Relative to a typical pick: every term that depends on the board (synergy with the
// allies, matchups against the enemies, the enemy's answers) is measured against the
// popularity-weighted average of the same terms over the champions usually played in
// that role, on the same board. These terms are not zero on average, and without this
// every score would drift up (or down) with the board; with it 50 stays "a typical pick
// here" and only differences from it move a score.
//
// Looking ahead: a pick is scored by what it is worth once the enemy has answered it.
// For every role the enemy still has open, their pick there follows a choice model
// learned from real matches (collector, counterpickTendency):
//   P(enemy picks Y in role q) ∝ popularity(Y, q) × exp(λ × Y's matchups against our team)
// λ says how much players pick against the champions they face (0: popularity only).
// A candidate's score is then
//   logit now − Σ open roles q  Σ_Y P(Y | q, with the candidate) × matchup(Y against candidate)
// so champions that are easy to counter, or weak against what is usually picked, score
// lower while picks are still open. When every enemy has locked in, nothing changes.
//
// Bans: banning a champion is worth what it would cost us if the enemy picked it,
// times how likely they are to pick it:
//   value = Σ over roles still open on the enemy team of
//           P(enemy picks it in that role) × (its logit there - the role's average pick)
// P is its share of a team's games in that role, divided by (1 - its ban rate) so
// champions that are often banned are not undervalued. The logit is the same model as
// for picks, seen from the enemy: their locked picks are its allies, our picks and
// pick intents its enemies, so a champion that counters our picks is worth more.
//   ban score = 100 × (1 - exp(-value / BAN_UNIT)), BAN_UNIT = 0.1 standard deviations
// of strength: a champion one standard deviation above its role's average that the
// enemy picks one game in ten scores 63. Fixed per model, not relative to the list.
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
  const UNCERTAINTY_Z = 1; // standard errors taken off an uncertain strength (see above)
  const BAN_UNIT = 0.1; // in standard deviations of strength, see the ban score above
  const BAN_MIN_GAMES = 20; // champion:role pairs with fewer games are not considered for bans
  const ANSWER_MIN_GAMES = 20; // enemy answers considered when looking ahead

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
    // Pair weights as { w, se }; the reversed key flips the sign for matchups.
    // A pair in several lists (results, early game) adds up.
    const pair = (lists, anti) => {
      const m = new Map();
      const add = (key, w, se) => {
        const e = m.get(key);
        m.set(key, e ? { w: e.w + w, se: Math.hypot(e.se, se) } : { w, se });
      };
      for (const list of lists) {
        for (const [a, ra, b, rb, w, se] of list || []) {
          add(`${a}:${ra}:${b}:${rb}`, w, se || 0);
          add(`${b}:${rb}:${a}:${ra}`, anti ? -w : w, se || 0);
        }
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
      syn: pair([model.syn, model.synE], false),
      vs: pair([model.vs, model.vsE], true),
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
    ix.lambda = Math.max(0, model.counterpick?.lambda || 0);
    ix.priorGames = Math.max(1, model.lambdas?.tau?.c || 100);
    // Usual standard error of strength per role, weighted by games
    ix.seRef = [0, 1, 2, 3, 4].map((r) => {
      let n = 0;
      let sum = 0;
      for (const [key, e] of champ) {
        if (Number(key.split(':')[1]) !== r || !e.se) continue;
        n += e.games;
        sum += e.games * e.se;
      }
      return n ? sum / n : 0;
    });
    if (model.comp) {
      const k = model.comp.k;
      const M = Array.from({ length: k }, () => new Float64Array(k));
      let n = 0;
      for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) {
          M[i][j] = model.comp.m[n];
          M[j][i] = -model.comp.m[n];
          n++;
        }
      }
      ix.comp = {
        k, M, a: model.comp.a, c: model.comp.c,
        U: new Map(Object.entries(model.comp.U).map(([id, u]) => [Number(id), Float64Array.from(u)])),
      };
    }
    // Ban inputs: how likely a team is to pick each champion:role, and the role's average pick
    ix.matches = model.matches || 0;
    ix.banRate = new Map(Object.entries(model.banRate || {}).map(([id, r]) => [Number(id), r]));
    ix.pickChance = new Map();
    ix.roleAverage = [0, 0, 0, 0, 0];
    const weightSum = [0, 0, 0, 0, 0];
    if (ix.matches) {
      for (const [key, e] of champ) {
        const [c, r] = key.split(':').map(Number);
        const p = Math.min(0.9, e.games / (2 * ix.matches) / Math.max(0.1, 1 - (ix.banRate.get(c) || 0)));
        ix.pickChance.set(key, p);
        ix.roleAverage[r] += p * (strengthOf(key, e) - ix.center);
        weightSum[r] += p;
      }
      for (let r = 0; r < 5; r++) ix.roleAverage[r] = weightSum[r] ? ix.roleAverage[r] / weightSum[r] : 0;
    }
    cache.set(model, ix);
    return ix;
  }

  const has = (model) => !!model && !!model.champ && Object.keys(model.champ).length > 0;
  const roleIndex = (ix, championId, position) =>
    position && ROLE_INDEX[position] !== undefined ? ROLE_INDEX[position] : ix.bestRole.get(championId)?.r ?? null;
  const toScore = (ix, x) => 50 + 50 * Math.tanh((SPREAD * x) / ix.sd);

  // A player on the board: { championId, position? } or a bare champion id
  const asPick = (p) => (typeof p === 'number' ? { championId: p, position: '' } : p);

  const dot = (a, b) => {
    if (!a || !b) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  };

  // How much a (in role ra) wins against b (in role rb), in log-odds: learned pair,
  // latent pair and class pair terms. Antisymmetric: matchup(b, a) = -matchup(a, b).
  function matchup(ix, a, ra, b, rb) {
    const explicit = ix.vs.get(`${a}:${ra}:${b}:${rb}`);
    const latent = ix.fm
      ? dot(ix.fm.P.get(`${a}:${ra}`), ix.fm.Q.get(`${b}:${rb}`)) - dot(ix.fm.P.get(`${b}:${rb}`), ix.fm.Q.get(`${a}:${ra}`))
      : 0;
    return (explicit ? explicit.w : 0) + latent + (ix.tv.get(`${ix.tags.get(a) || 'None'}:${ix.tags.get(b) || 'None'}`) || 0);
  }

  // How well a (role ra) and b (role rb) play on the same team, in log-odds
  function synergy(ix, a, ra, b, rb) {
    const explicit = ix.syn.get(`${a}:${ra}:${b}:${rb}`);
    const latent = ix.fm ? dot(ix.fm.S.get(`${a}:${ra}`), ix.fm.S.get(`${b}:${rb}`)) : 0;
    return (explicit ? explicit.w : 0) + latent + (ix.ts.get(`${ix.tags.get(a) || 'None'}:${ix.tags.get(b) || 'None'}`) || 0);
  }

  // Style of a team: the sum of its champions' style numbers, plus an expected future part
  function styleOf(ix, ids, extra = null) {
    const T = new Float64Array(ix.comp.k);
    for (const id of ids) {
      const u = ix.comp.U.get(id);
      if (u) for (let k = 0; k < T.length; k++) T[k] += u[k];
    }
    if (extra) for (let k = 0; k < T.length; k++) T[k] += extra[k];
    return T;
  }

  // What the champion adds to its team's composition, given the two teams' styles without it
  function compValue(ix, championId, A, E) {
    const u = ix.comp.U.get(championId);
    if (!u) return 0;
    const { a, c, M } = ix.comp;
    let v = 0;
    for (let k = 0; k < u.length; k++) {
      v += a[k] * (Math.tanh(A[k] + u[k] + c[k]) - Math.tanh(A[k] + c[k]));
      for (let j = 0; j < u.length; j++) v += u[k] * M[k][j] * E[j];
    }
    return v;
  }

  // future: { allyStyle, enemyStyle } expected styles of the picks still to come (or null)
  function scoreOne(ix, championId, r, allies, enemies, future = null) {
    const self = `${championId}:${r}`;
    const e = ix.champ.get(self);
    const share = e ? e.share : 0;
    const doubt = e && e.se ? UNCERTAINTY_Z * Math.max(0, e.se - ix.seRef[r]) : 0;
    const base = (e ? e.w : 0) + ix.off[r] * -Math.log(Math.max(share, ix.floor)) - ix.center - doubt;
    const tag = ix.tags.get(championId) || 'None';
    // Champions never seen in this role have no standard error: treat them as very unsure
    let variance = e ? e.se * e.se : 1;

    let syn = 0;
    const allyHits = [];
    for (const p of allies.map(asPick)) {
      if (p.championId === championId) continue;
      const ra = roleIndex(ix, p.championId, p.position);
      const explicit = ra === null ? null : ix.syn.get(`${championId}:${r}:${p.championId}:${ra}`);
      if (explicit) variance += explicit.se * explicit.se;
      const v = ra === null
        ? ix.ts.get(`${tag}:${ix.tags.get(p.championId) || 'None'}`) || 0
        : synergy(ix, championId, r, p.championId, ra);
      syn += v;
      if (v) allyHits.push({ championId: p.championId, value: v });
    }

    let mu = 0;
    const enemyHits = [];
    for (const p of enemies.map(asPick)) {
      const re = roleIndex(ix, p.championId, p.position);
      const explicit = re === null ? null : ix.vs.get(`${championId}:${r}:${p.championId}:${re}`);
      if (explicit) variance += explicit.se * explicit.se;
      const v = re === null
        ? ix.tv.get(`${tag}:${ix.tags.get(p.championId) || 'None'}`) || 0
        : matchup(ix, championId, r, p.championId, re);
      mu += v;
      if (v) enemyHits.push({ championId: p.championId, value: v, lane: re === r });
    }

    const comp = ix.comp
      ? compValue(
          ix,
          championId,
          styleOf(ix, allies.map((p) => asPick(p).championId).filter((id) => id !== championId), future?.allyStyle),
          styleOf(ix, enemies.map((p) => asPick(p).championId), future?.enemyStyle),
        )
      : 0;

    const logit = base + syn + mu + comp;
    const score = toScore(ix, logit);
    const baseScore = toScore(ix, base);
    return {
      championId,
      role: ROLES[r],
      base: Math.round(baseScore),
      synergy: Math.round(toScore(ix, base + syn) - baseScore),
      matchup: Math.round(toScore(ix, base + syn + mu) - toScore(ix, base + syn)),
      composition: Math.round(score - toScore(ix, base + syn + mu)),
      score: Math.round(score),
      logit,
      baseLogit: base,
      offRole: share < OFF_ROLE_SHARE,
      games: e ? e.games : 0,
      uncertainty: Math.round((50 * SPREAD * Math.sqrt(variance)) / ix.sd),
      unsure: !e || e.games < UNSURE_GAMES,
      allies: allyHits.sort((x, y) => y.value - x.value),
      enemies: enemyHits.sort((x, y) => Math.abs(y.value) - Math.abs(x.value)),
    };
  }

  /**
   * Champions likely to be picked in the open roles of one team: per role, champions with
   * enough games there, with choice weight log popularity + λ × matchups against the
   * other team's picks. skip: a role not to fill (the candidate's own).
   */
  function openPicks(ix, team, other, unavailable, skip = null) {
    if (!ix.matches) return [];
    const onBoard = new Set([...team, ...other].map((p) => asPick(p).championId));
    const taken = new Set(team.map((p) => roleIndex(ix, asPick(p).championId, asPick(p).position)));
    const theirs = other.map(asPick).map((p) => [p.championId, roleIndex(ix, p.championId, p.position)]).filter(([, r]) => r !== null);
    const out = [];
    for (let q = 0; q < 5; q++) {
      if (taken.has(q) || q === skip) continue;
      const list = [];
      for (const [key, e] of ix.champ) {
        const [y, rq] = key.split(':').map(Number);
        if (rq !== q || e.games < ANSWER_MIN_GAMES || unavailable.has(y) || onBoard.has(y)) continue;
        let w = Math.log(Math.max(ix.pickChance.get(key) || 0, 1e-6));
        for (const [c, rc] of theirs) w += ix.lambda * matchup(ix, y, q, c, rc);
        list.push({ y, w });
      }
      if (list.length) out.push({ q, list });
    }
    return out;
  }

  // The enemy's possible answers to us (see openPicks)
  const answers = (ix, allies, enemies, unavailable) => openPicks(ix, enemies, allies, unavailable);

  // Choice weights -> probabilities, per role
  function probabilities(open) {
    return open.map(({ q, list }) => {
      const max = Math.max(...list.map((a) => a.w));
      const p = list.map((a) => Math.exp(a.w - max));
      const sum = p.reduce((x, y) => x + y, 0);
      return { q, list: list.map((a, i) => ({ y: a.y, p: p[i] / sum })) };
    });
  }

  // Expected style of the picks still to come
  function expectedStyle(ix, open) {
    const T = new Float64Array(ix.comp.k);
    for (const { list } of open) {
      for (const { y, p } of list) {
        const u = ix.comp.U.get(y);
        if (u) for (let k = 0; k < T.length; k++) T[k] += p * u[k];
      }
    }
    return T;
  }

  /**
   * The rest of the draft for a candidate in role r, built once per board: the enemy's
   * answers, our own picks to come (with probabilities) and the expected styles.
   */
  function restOfDraft(ix, r, allies, enemies, unavailable) {
    const ids = (list) => list.map((p) => `${asPick(p).championId}:${asPick(p).position || ''}`).join(',');
    const key = `${r}|${ids(allies)}|${ids(enemies)}|${[...unavailable].sort().join(',')}`;
    ix.rest ||= new Map();
    if (ix.rest.has(key)) return ix.rest.get(key);
    if (ix.rest.size > 100) ix.rest.clear();
    const out = buildRest(ix, r, allies, enemies, unavailable);
    ix.rest.set(key, out);
    return out;
  }

  function buildRest(ix, r, allies, enemies, unavailable) {
    const enemyOpen = answers(ix, allies, enemies, unavailable);
    const allyOpen = probabilities(openPicks(ix, allies, enemies, unavailable, r));
    const future = ix.comp ? { allyStyle: expectedStyle(ix, allyOpen), enemyStyle: expectedStyle(ix, probabilities(enemyOpen)) } : null;
    return { enemyOpen, allyOpen, future };
  }

  /** Expected log-odds the candidate loses once the enemy answers it in every open role */
  function exposure(ix, championId, r, open) {
    let total = 0;
    for (const { q, list } of open) {
      let max = -Infinity;
      const m = new Float64Array(list.length);
      const w = new Float64Array(list.length);
      list.forEach((ans, i) => {
        if (ans.y === championId) {
          w[i] = -Infinity;
          return;
        }
        m[i] = matchup(ix, ans.y, q, championId, r);
        w[i] = ans.w + ix.lambda * m[i];
        if (w[i] > max) max = w[i];
      });
      let sum = 0;
      let acc = 0;
      for (let i = 0; i < list.length; i++) {
        if (w[i] === -Infinity) continue;
        const p = Math.exp(w[i] - max);
        sum += p;
        acc += p * m[i];
      }
      if (sum) total += acc / sum;
    }
    return total;
  }

  // Expected synergy of the candidate with the picks our team still has to make
  function futureSynergy(ix, championId, r, allyOpen) {
    let total = 0;
    for (const { q, list } of allyOpen) for (const { y, p } of list) if (y !== championId) total += p * synergy(ix, championId, r, y, q);
    return total;
  }

  /**
   * Everything the board does to a candidate, in log-odds: the row (with the composition,
   * and the expected final styles when looking ahead), its expected synergy with our
   * future picks and its exposure to the enemy's answers.
   */
  function assess(ix, championId, r, allies, enemies, rest) {
    const row = scoreOne(ix, championId, r, allies, enemies, rest ? rest.future : null);
    if (!rest) return { row, ahead: 0, exposure: 0 };
    return { row, ahead: futureSynergy(ix, championId, r, rest.allyOpen), exposure: exposure(ix, championId, r, rest.enemyOpen) };
  }

  // The player's own layer on top of the model; personal is what it adds in points
  function personalize(ix, row, personal) {
    if (!personal) return row;
    const own = personal.byKey?.[`${row.championId}:${row.role}`];
    const delta = own ? own.delta : personal.unplayed || 0;
    if (!delta) return { ...row, personal: 0, personalGames: own?.games || 0 };
    const logit = row.logit + delta;
    const score = Math.round(toScore(ix, logit));
    return { ...row, logit, score, personal: score - row.score, personalGames: own?.games || 0 };
  }

  /**
   * What the board does to a typical pick in role r: popularity-weighted averages, over the
   * champions usually played there, of the board terms, the rest of the draft and the
   * enemy's answers. Cached per board.
   */
  function typical(ix, r, allies, enemies, rest, unavailable) {
    const ids = (list) => list.map((p) => `${asPick(p).championId}:${asPick(p).position || ''}`).join(',');
    const key = `${r}|${ids(allies)}|${ids(enemies)}|${rest ? 1 : 0}|${[...unavailable].sort().join(',')}`;
    ix.typical ||= new Map();
    if (ix.typical.has(key)) return ix.typical.get(key);
    const onBoard = new Set([...allies, ...enemies].map((p) => asPick(p).championId));
    let sum = 0;
    let board = 0;
    let ahead = 0;
    let exp = 0;
    for (const [k, e] of ix.champ) {
      const [y, ry] = k.split(':').map(Number);
      if (ry !== r || e.games < ANSWER_MIN_GAMES || unavailable.has(y) || onBoard.has(y)) continue;
      const p = ix.pickChance.get(k) || 0;
      if (!p) continue;
      const a = assess(ix, y, r, allies, enemies, rest);
      sum += p;
      board += p * (a.row.logit - a.row.baseLogit);
      ahead += p * a.ahead;
      exp += p * a.exposure;
    }
    const out = sum ? { board: board / sum, ahead: ahead / sum, exposure: exp / sum } : { board: 0, ahead: 0, exposure: 0 };
    if (ix.typical.size > 300) ix.typical.clear();
    ix.typical.set(key, out);
    return out;
  }

  /**
   * The final row of a candidate: board terms against a typical pick's, then (looking
   * ahead) the rest of the draft and the enemy's answers against a typical pick's.
   * counterRisk is what the enemy's answers cost in points (negative: it gains).
   */
  function finalRow(ix, a, typ, rest) {
    const logit = a.row.logit - typ.board;
    const row = { ...a.row, logit, score: Math.round(toScore(ix, logit)) };
    if (!rest) return row;
    // Look-ahead terms count by the evidence behind this champion in this role
    const rel = a.row.games / (a.row.games + ix.priorGames);
    const withFuture = logit + rel * (a.ahead - typ.ahead);
    const final = withFuture - rel * (a.exposure - typ.exposure);
    const score = Math.round(toScore(ix, final));
    return { ...row, logit: final, score, counterRisk: Math.round(toScore(ix, withFuture)) - score };
  }

  /** Same arguments and result as Recommend.recommend, plus model. Scores look ahead (see above). */
  function recommend({ model, role = '', unavailable = new Set(), pickable = null, allies = [], enemies = [], pool = [], limit = 10, personal = null }) {
    const ix = index(model);
    const allowed = pickable ? new Set(pickable) : null;
    const inPool = new Set(pool);
    const rests = new Map();
    const restFor = (r) => {
      if (!rests.has(r)) rests.set(r, restOfDraft(ix, r, allies, enemies, unavailable));
      return rests.get(r);
    };
    const out = [];
    for (const [championId, best] of ix.bestRole) {
      if (unavailable.has(championId) || (allowed && !allowed.has(championId))) continue;
      const r = role ? ROLE_INDEX[role] : best.r;
      const entry = ix.champ.get(`${championId}:${r}`);
      if (!entry) continue; // never seen in this role (see above)
      const rest = ix.matches ? restFor(r) : null;
      const typ = typical(ix, r, allies, enemies, rest, unavailable);
      const row = finalRow(ix, assess(ix, championId, r, allies, enemies, rest), typ, rest);
      out.push({ ...personalize(ix, { counterRisk: 0, ...row }, personal), inPool: inPool.has(championId) });
    }
    return out.sort((x, y) => y.logit - x.logit || y.games - x.games).slice(0, limit);
  }

  /**
   * Same arguments and result as Recommend.evaluate, plus model. With lookAhead the score
   * takes the rest of the draft into account like recommend() (for a pick not locked yet).
   */
  function evaluate({ model, championId, role = '', allies = [], enemies = [], lookAhead: ahead = false, unavailable = new Set(), personal = null }) {
    const ix = index(model);
    if (!ix.bestRole.has(championId)) return null;
    const r = role ? ROLE_INDEX[role] : ix.bestRole.get(championId).r;
    const rest = ahead && ix.matches ? restOfDraft(ix, r, allies, enemies, unavailable) : null;
    const typ = typical(ix, r, allies, enemies, rest, unavailable);
    const row = finalRow(ix, assess(ix, championId, r, allies, enemies, rest), typ, rest);
    return personalize(ix, ahead ? { counterRisk: 0, ...row } : row, personal);
  }

  /**
   * Ban suggestions: { model, unavailable, allies, enemies, limit }. allies are our
   * picks and pick intents, enemies the enemy's locked picks (both { championId, position }).
   * Returns [{ championId, score, role, pickChance, value }], best ban first.
   */
  function recommendBans({ model, unavailable = new Set(), allies = [], enemies = [], limit = 10 }) {
    const ix = index(model);
    if (!ix.matches) return [];
    const mine = new Set(allies.map((p) => asPick(p).championId));
    const taken = new Set(enemies.map((p) => roleIndex(ix, asPick(p).championId, asPick(p).position)));
    const out = [];
    for (const championId of ix.bestRole.keys()) {
      if (unavailable.has(championId) || mine.has(championId)) continue;
      let value = 0;
      let main = null;
      for (let r = 0; r < 5; r++) {
        if (taken.has(r)) continue;
        const key = `${championId}:${r}`;
        const e = ix.champ.get(key);
        if (!e || e.games < BAN_MIN_GAMES) continue;
        const p = ix.pickChance.get(key) || 0;
        const harm = scoreOne(ix, championId, r, enemies, allies).logit - ix.roleAverage[r];
        const part = p * harm;
        value += part;
        if (!main || part > main.part) main = { r, part, p };
      }
      if (!main || value <= 0) continue;
      out.push({
        championId,
        value,
        score: Math.round(100 * (1 - Math.exp(-value / (BAN_UNIT * ix.sd)))),
        role: ROLES[main.r],
        pickChance: main.p,
      });
    }
    return out.sort((a, b) => b.value - a.value).slice(0, limit);
  }

  // All orders of the five roles, for guessing who plays what
  const PERMUTATIONS = (() => {
    const out = [];
    const walk = (left, acc) => {
      if (!left.length) return out.push(acc);
      left.forEach((r, i) => walk([...left.slice(0, i), ...left.slice(i + 1)], [...acc, r]));
    };
    walk([0, 1, 2, 3, 4], []);
    return out;
  })();

  /**
   * Roles of a team's five players: [{ championId, position }] -> role names. A known
   * position is kept; the others get the most likely assignment of the roles left, from
   * how often each champion is played in each role (champions not picked yet fill what
   * remains, in order). guessed[i] says the role was guessed.
   */
  function guessRoles({ model, players }) {
    const ix = index(model);
    let best = null;
    for (const perm of PERMUTATIONS) {
      let ok = true;
      let score = 0;
      players.forEach((p, i) => {
        const r = perm[i];
        if (p.position) {
          if (ROLE_INDEX[p.position] !== r) ok = false;
        } else if (p.championId) {
          const e = ix.champ.get(`${p.championId}:${r}`);
          score += Math.log(Math.max(e ? e.share : 0, 1e-4));
        } else {
          score -= r * 1e-6; // unknown players: keep their order
        }
      });
      if (ok && (!best || score > best.score)) best = { perm, score };
    }
    if (!best) return { roles: players.map((p) => p.position || ''), guessed: players.map(() => false) };
    return {
      roles: best.perm.map((r, i) => players[i].position || ROLES[r]),
      guessed: players.map((p) => !p.position),
    };
  }

  // Older engine (recommend.js) takes allies as champion ids
  const legacy = (args) => ({ ...args, allies: (args.allies || []).map((p) => asPick(p).championId) });

  const Engine = {
    recommend: (args) => (has(args.model) ? recommend(args) : root.Recommend.recommend(legacy(args))),
    evaluate: (args) => (has(args.model) ? evaluate(args) : root.Recommend.evaluate(legacy(args))),
    // Bans need the learned model; without one there are no suggestions
    recommendBans: (args) => (has(args.model) ? recommendBans(args) : []),
    guessRoles: (args) => (has(args.model) && args.players.length === 5 ? guessRoles(args) : null),
  };

  const api = { recommend, evaluate, recommendBans, guessRoles, Engine, ROLES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
