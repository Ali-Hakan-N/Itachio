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
// Personal layer: how the player does on the champion (collector/src/players), from three
// sources: personal = { season, history, team }, each { byKey: { "<champ>:<role name>":
// { delta, games } }, unplayed } (champions not played there get unplayed). season is
// their ranked games of the season, history those of the patch, team those where all five
// on their side were the team members of this draft (personalFor picks the line-up). delta is in log-odds,
// already shrunk hard toward the player's own level for champions with few games. The
// sources add up, count PERSONAL_WEIGHT of that, and are capped at PERSONAL_CAP standard
// deviations of strength (about 7 points): a nudge, never what makes a pick.
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
// games add up. Champions never seen in a role, or picked there by less than
// MIN_PICK_RATE of teams (off-meta), are not recommended; they can still be hovered and
// scored.
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
  const Traits = root.Traits || (typeof require === 'function' ? require('./traits') : null);
  const ROLES = ['top', 'jungle', 'middle', 'bottom', 'utility'];
  const ROLE_INDEX = Object.fromEntries(ROLES.map((r, i) => [r, i]));
  const OFF_ROLE_SHARE = 0.05; // below this share a pick is marked off-role
  const SPREAD = 0.35; // how far one standard deviation of strength moves the score
  const SCALE_MIN_GAMES = 100; // champion:role pairs that define the scale
  const UNSURE_GAMES = 100; // fewer games than this in the role: rough estimate
  const UNCERTAINTY_Z = 1; // standard errors taken off an uncertain strength (see above)
  const LANE_CALL = 0.6; // a lane is ahead or behind beyond this many standard deviations of its role (game plan and lane penalty)
  const EDGE_PCT = 1; // game plan: an edge counts from this many percentage points of win chance
  const PERSONAL_WEIGHT = 1;
  const POOL_GAMES = 10; // games on a champion for it to count fully in a player's pool
  const POOL_MASTERY = 0.4; // mastery (0-1) that makes a champion comfortable without results
  const POOL_NORMAL = 4; // a pool of this size changes nothing in the pick order
  const POOL_WEIGHT = 6; // pick order points between a pool of none and a pool of POOL_NORMAL
  const LANE_PENALTY = 0.5; // share of a lane loss beyond the threshold that is taken off the logit
  const LANE_AMORTIZE = 1.5; // a lane loss is forgiven once the composition gain is this many times the loss
  const PERSONAL_CAP = 1.5; // in standard deviations of strength
  const ROLE_PRIOR = 15; // pseudo-games shrinking a player's average on a role toward zero (line-up roles)
  const ROLE_EXPERIENCE = 0.4; // standard deviations for a role that is most of a player's games
  const POOL_DEPTH = 0.3; // standard deviations between a deep and a shallow pool on the role
  const NEW_ROLE = 0.5; // standard deviations lost on a role a known player never plays
  const ROLE_CHOICE = 0.3; // standard deviations for the roles a player chose (Team tab) or queued for
  const ROLE_EVIDENCE_GAMES = 250; // games of a champion in a role at which the model is trusted about 63% on it
  const PICK_BLIND = { top: 10, middle: 8, jungle: 3, bottom: 3, utility: 1 }; // points of exposure to a counter while the opponent is unseen
  const PICK_EAGER = 3; // points per slot of waiting once the opponent is on the board
  const PICK_TRADE = 0.5; // points per slot of distance from the client's order
  const HISTORY_PRIOR = 2; // games of each result a team's record against a champion starts from
  const HISTORY_CONFIDENCE = 4; // games at which the record counts half
  const HISTORY_CAP = 0.5; // log-odds of losing counted at most
  const HISTORY_PICK_FLOOR = 0.15; // pick chance assumed for a champion the model has not seen
  const PERSONAL_CLASS_PRIOR = 40; // pseudo-games before class-level comfort transfers to an unseen champion
  const MIN_PICK_RATE = 0.01; // share of teams picking it in the role, to be recommended
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
      heuristics: model.heuristics,
      blindability: new Map(Object.entries(model.blindability?.byKey || {})),
      off: model.off || [0, 0, 0, 0, 0],
      floor: model.shareFloor || 0.002,
      early: model.early || null,
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
    // How popular each champion is in each role (rank 1 = most picked), shown, not scored
    ix.popRank = new Map();
    for (let r = 0; r < 5; r++) {
      [...champ].filter(([key]) => Number(key.split(':')[1]) === r).sort((x, y) => y[1].games - x[1].games)
        .forEach(([key], i) => ix.popRank.set(key, i + 1));
    }
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
    ix.pillars = model.pillars || null;
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

  // Unknown roles are distributed over valid team assignments, weighted by role share.
  // This prevents two flex picks from both being treated as the same most-played role.
  function roleAssignments(ix, picks, against = []) {
    const team = picks.map(asPick);
    if (!team.length) return [{ roles: [], probability: 1 }];
    const key = `${team.map((p) => `${p.championId}:${p.position || ''}`).join(',')}|vs:${against.map((p) => `${asPick(p).championId}:${asPick(p).position || ''}`).join(',')}`;
    ix.roleAssignmentCache ||= new Map();
    const cached = ix.roleAssignmentCache.get(key);
    if (cached) return cached;

    const choices = team.map((pick) => {
      if (pick.position && ROLE_INDEX[pick.position] !== undefined) return [{ role: ROLE_INDEX[pick.position], weight: 1 }];
      const available = [];
      for (let role = 0; role < 5; role++) {
        const entry = ix.champ.get(`${pick.championId}:${role}`);
        if (entry?.share > 0) available.push({ role, weight: entry.share });
      }
      if (!available.length) {
        const best = ix.bestRole.get(pick.championId)?.r;
        return best === undefined ? [] : [{ role: best, weight: 1 }];
      }
      return available;
    });
    if (choices.some((list) => !list.length)) return [];

    const assignments = [];
    const selected = [];
    const visit = (i, used, probability) => {
      if (i === team.length) {
        assignments.push({ roles: [...selected], rawProbability: probability });
        return;
      }
      for (const option of choices[i]) {
        if (used.has(option.role)) continue;
        used.add(option.role);
        selected.push(option.role);
        visit(i + 1, used, probability * option.weight);
        selected.pop();
        used.delete(option.role);
      }
    };
    visit(0, new Set(), 1);
    if (!assignments.length) return [];

    if (against.length) {
      const opposingAssignments = roleAssignments(ix, against);
      for (const assignment of assignments) {
        let teamSynergy = 0;
        for (let i = 0; i < team.length; i++) for (let j = i + 1; j < team.length; j++) {
          teamSynergy += synergy(ix, team[i].championId, assignment.roles[i], team[j].championId, assignment.roles[j]);
        }
        let expectedCounter = 0;
        for (const opposing of opposingAssignments) {
          let counter = 0;
          for (let i = 0; i < team.length; i++) {
            for (let j = 0; j < opposing.roles.length; j++) {
              counter += matchup(ix, team[i].championId, assignment.roles[i], asPick(against[j]).championId, opposing.roles[j]);
            }
          }
          expectedCounter += opposing.probability * counter;
        }
        assignment.rawProbability *= Math.exp(Math.max(-30, Math.min(30, ix.lambda * expectedCounter + 0.5 * teamSynergy)));
      }
    } else {
      for (const assignment of assignments) {
        let teamSynergy = 0;
        for (let i = 0; i < team.length; i++) for (let j = i + 1; j < team.length; j++) {
          teamSynergy += synergy(ix, team[i].championId, assignment.roles[i], team[j].championId, assignment.roles[j]);
        }
        assignment.rawProbability *= Math.exp(Math.max(-30, Math.min(30, 0.5 * teamSynergy)));
      }
    }
    const sum = assignments.reduce((total, assignment) => total + assignment.rawProbability, 0) || 1;
    for (const assignment of assignments) {
      assignment.probability = assignment.rawProbability / sum;
      delete assignment.rawProbability;
    }
    if (ix.roleAssignmentCache.size > 200) ix.roleAssignmentCache.clear();
    ix.roleAssignmentCache.set(key, assignments);
    return assignments;
  }

  function roleDistribution({ model, picks, against = [] }) {
    if (!has(model)) return [];
    const assignments = roleAssignments(index(model), picks, against);
    return picks.map((pick, i) => {
      const roles = new Map();
      for (const assignment of assignments) {
        const role = ROLES[assignment.roles[i]];
        roles.set(role, (roles.get(role) || 0) + assignment.probability);
      }
      return { championId: asPick(pick).championId, roles: Object.fromEntries(roles) };
    });
  }

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
    return (explicit ? explicit.w : 0) + latent + (ix.ts.get(`${ix.tags.get(a) || 'None'}:${ix.tags.get(b) || 'None'}`) || 0) + pairPrior(ix, a, b);
  }

  // Hand-made duo prior (curated pairs and trait fits, traits.js): results are too noisy to
  // teach most duos, so this keeps the known ones in the suggestions
  function pairPrior(ix, a, b) {
    if (!Traits || ix.heuristics === false) return 0;
    const key = a < b ? a * 4096 + b : b * 4096 + a;
    ix.pairPriors ||= new Map();
    let v = ix.pairPriors.get(key);
    if (v === undefined) {
      v = ix.sd * Traits.pairBonus(a, ix.tags.get(a), b, ix.tags.get(b));
      ix.pairPriors.set(key, v);
    }
    return v;
  }

  // Composition rules of a team (damage split, frontline, CC, engage, one plan), as a loss in logit
  function teamFit(ix, ids) {
    if (!Traits || ix.heuristics === false) return { penalty: 0, lacking: [] };
    return Traits.teamFit(ids.map((id) => ({ id, tag: ix.tags.get(id) })));
  }

  // How much a candidate supports the plan its allies are building, as a gain in logit
  function planFit(ix, allyIds, id) {
    if (!Traits || ix.heuristics === false) return 0;
    return ix.sd * Traits.planSupport(allyIds.map((a) => ({ id: a, tag: ix.tags.get(a) })), { id, tag: ix.tags.get(id) });
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

  function pillarProfile(ix, team) {
    let ap = 0;
    let ad = 0;
    let frontline = 0;
    let control = 0;
    let marksman = 0;
    for (const id of team) {
      const tag = ix.tags.get(id) || 'None';
      if (tag === 'Mage') ap += 1;
      if (tag === 'Support') ap += 0.5;
      if (tag === 'Marksman' || tag === 'Assassin' || tag === 'Fighter') ad += 1;
      if (tag === 'Marksman') marksman += 1;
      if (tag === 'Tank') frontline += 1;
      if (tag === 'Fighter') frontline += 0.5;
      if (tag === 'Tank' || tag === 'Support') control += 1;
      if (tag === 'Mage') control += 0.5;
    }
    const controlShare = control / 5;
    const damageLoad = (ap + ad) / 5;
    const frontlineShare = frontline / 5;
    return {
      damageImbalance: Math.abs(Math.log((ap + 0.5) / (ad + 0.5))),
      frontline: frontlineShare,
      control: controlShare,
      highDamageLowControl: damageLoad * (1 - controlShare),
      frontlineMarksman: frontlineShare * (marksman / 5),
      adHeavy: Math.max(0, Math.log((ad + 0.5) / (ap + 0.5))),
    };
  }

  function pillarValue(ix, ourTeam, enemyTeam) {
    if (!ix.pillars) return 0;
    const ours = pillarProfile(ix, ourTeam);
    const theirs = pillarProfile(ix, enemyTeam);
    return (ix.pillars.damageImbalance || 0) * (ours.damageImbalance - theirs.damageImbalance)
      + (ix.pillars.frontline || 0) * (ours.frontline - theirs.frontline)
      + (ix.pillars.control || 0) * (ours.control - theirs.control)
      + (ix.pillars.highDamageLowControl || 0) * (ours.highDamageLowControl - theirs.highDamageLowControl)
      + (ix.pillars.frontlineMarksman || 0) * (ours.frontlineMarksman - theirs.frontlineMarksman)
      + (ix.pillars.adIntoFrontline || 0) * (ours.adHeavy * theirs.frontline - theirs.adHeavy * ours.frontline);
  }

  /**
   * Lane tools from the early game model: sdOf (spread of lane results per role, over
   * champions played there often) and laneOf(role, a, b) -> { diff, games }, the lane
   * result of a against b (the learned pairing when it has games, else the average lanes).
   */
  function laneTools(ix) {
    if (ix.laneTools !== undefined) return ix.laneTools;
    const lane = ix.early?.laneMean;
    if (!lane) return (ix.laneTools = null);
    const sdOf = [0, 1, 2, 3, 4].map((r) => {
      const v = Object.entries(lane).filter(([k]) => Number(k.split(':')[1]) === r && (ix.champ.get(k)?.games || 0) >= SCALE_MIN_GAMES).map(([, x]) => x);
      if (v.length < 5) return 0.05;
      const m = v.reduce((a, x) => a + x, 0) / v.length;
      return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length) || 0.05;
    });
    const vs = new Map((ix.early.laneVs || []).map(([k, a, b, v, n]) => [`${k}:${a}:${b}`, { v, n }]));
    const laneOf = (r, a, b) => {
      const [x, y, sign] = a < b ? [a, b, 1] : [b, a, -1];
      const learned = vs.get(`${r}:${x}:${y}`);
      if (learned) return { diff: sign * learned.v, games: learned.n };
      return { diff: (lane[`${a}:${r}`] ?? 0) - (lane[`${b}:${r}`] ?? 0), games: 0 };
    };
    return (ix.laneTools = { sdOf, laneOf });
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
    let laneDiff = 0; // expected lane result against the enemies who may be in this lane, log-odds
    const enemyHits = [];
    const enemyPicks = enemies.map(asPick);
    const assignments = roleAssignments(ix, enemyPicks, [...allies, { championId, position: ROLES[r] }]);
    const tools = laneTools(ix);
    for (let i = 0; i < enemyPicks.length; i++) {
      const p = enemyPicks[i];
      const roleProbabilities = new Map();
      let expectedMatchup = 0;
      for (const assignment of assignments) {
        const enemyRole = assignment.roles[i];
        roleProbabilities.set(enemyRole, (roleProbabilities.get(enemyRole) || 0) + assignment.probability);
        expectedMatchup += assignment.probability * matchup(ix, championId, r, p.championId, enemyRole);
      }
      mu += expectedMatchup;
      const inLane = roleProbabilities.get(r) || 0;
      if (tools && inLane) laneDiff += inLane * tools.laneOf(r, championId, p.championId).diff;
      if (expectedMatchup) enemyHits.push({
        championId: p.championId,
        value: expectedMatchup,
        lane: roleProbabilities.get(r) || 0,
        roleProbabilities: Object.fromEntries([...roleProbabilities].map(([enemyRole, probability]) => [ROLES[enemyRole], probability])),
      });
    }

    const ourIds = [...allies.map((p) => asPick(p).championId).filter((id) => id && id !== championId), championId];
    const fit = teamFit(ix, ourIds);
    const learned = (ix.comp
      ? compValue(
          ix,
          championId,
          styleOf(ix, allies.map((p) => asPick(p).championId).filter((id) => id !== championId), future?.allyStyle),
          styleOf(ix, enemies.map((p) => asPick(p).championId), future?.enemyStyle),
        )
      : 0) + pillarValue(ix,
        [...allies.map((p) => asPick(p).championId).filter((id) => id !== championId), championId],
        enemies.map((p) => asPick(p).championId));
    const plan = planFit(ix, ourIds.slice(0, -1), championId);
    const comp = -ix.sd * fit.penalty + learned + plan;

    // Losing the lane hard (beyond LANE_CALL standard deviations of the role) costs extra
    // unless the composition gain makes it up by LANE_AMORTIZE times the excess loss
    let lanePenalty = 0;
    if (tools && laneDiff < 0) {
      const excess = -laneDiff - LANE_CALL * tools.sdOf[r];
      if (excess > 0) lanePenalty = LANE_PENALTY * Math.max(0, excess - Math.max(0, comp) / LANE_AMORTIZE);
    }

    const before = base + syn + mu + comp;
    const logit = before - lanePenalty;
    const score = toScore(ix, logit);
    const baseScore = toScore(ix, base);
    return {
      championId,
      role: ROLES[r],
      base: Math.round(baseScore),
      synergy: Math.round(toScore(ix, base + syn) - baseScore),
      matchup: Math.round(toScore(ix, base + syn + mu) - toScore(ix, base + syn)),
      composition: Math.round(toScore(ix, before) - toScore(ix, base + syn + mu)),
      lane: Math.round(score - toScore(ix, before)),
      score: Math.round(score),
      logit,
      baseLogit: base,
      // The logit as its parts (they add up to it once finalRow and personalize are done)
      parts: {
        strength: base, synergy: syn, matchup: mu, learned, plan,
        damage: -ix.sd * (fit.damage || 0), needs: -ix.sd * (fit.needs || 0), coherence: -ix.sd * (fit.coherence || 0),
        lane: -lanePenalty, typical: 0, ahead: 0, exposure: 0, personal: 0,
      },
      lacking: fit.lacking || [],
      offRole: share < OFF_ROLE_SHARE,
      games: e ? e.games : 0,
      pickRate: e && ix.matches ? e.games / (2 * ix.matches) : 0,
      popRank: ix.popRank.get(self) || 0,
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
  function restOfDraft(ix, r, allies, enemies, unavailable, answerShare = 1) {
    const ids = (list) => list.map((p) => `${asPick(p).championId}:${asPick(p).position || ''}`).join(',');
    const key = `${r}|${ids(allies)}|${ids(enemies)}|${[...unavailable].sort().join(',')}`;
    ix.rest ||= new Map();
    if (ix.rest.has(key)) return ix.rest.get(key);
    if (ix.rest.size > 100) ix.rest.clear();
    const out = buildRest(ix, r, allies, enemies, unavailable, answerShare);
    ix.rest.set(key, out);
    return out;
  }

  function buildRest(ix, r, allies, enemies, unavailable, answerShare = 1) {
    const enemyOpen = answers(ix, allies, enemies, unavailable);
    const allyOpen = probabilities(openPicks(ix, allies, enemies, unavailable, r));
    const future = ix.comp ? { allyStyle: expectedStyle(ix, allyOpen), enemyStyle: expectedStyle(ix, probabilities(enemyOpen)) } : null;
    return { enemyOpen, allyOpen, future, answerShare };
  }

  /**
   * Expected log-odds the candidate loses once the enemy answers it in every open role.
   * answered: share of the open enemy picks that come after ours and can see it; the rest
   * pick without knowing it (lambda 0 for the candidate's matchups), so only the answers count.
   */
  function exposure(ix, championId, r, open, answered = 1) {
    let total = 0;
    for (const { q, list } of open) {
      const m = new Float64Array(list.length);
      list.forEach((ans, i) => {
        m[i] = ans.y === championId ? 0 : matchup(ix, ans.y, q, championId, r);
      });
      const expect = (lambda) => {
        let max = -Infinity;
        const w = new Float64Array(list.length);
        list.forEach((ans, i) => {
          w[i] = ans.y === championId ? -Infinity : ans.w + lambda * m[i];
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
        return sum ? acc / sum : 0;
      };
      total += (answered > 0 ? answered * expect(ix.lambda) : 0) + (answered < 1 ? (1 - answered) * expect(0) : 0);
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
    return { row, ahead: futureSynergy(ix, championId, r, rest.allyOpen), exposure: exposure(ix, championId, r, rest.enemyOpen, rest.answerShare) };
  }

  // The player's own layer on top of the model; personal is what it adds in points
  function personalize(ix, row, personal) {
    if (!personal) return row;
    let sum = 0;
    let games = 0;
    const tag = ix.tags.get(row.championId) || 'None';
    for (const src of [personal.season, personal.history, personal.team]) {
      if (!src) continue;
      const own = src.byKey?.[`${row.championId}:${row.role}`];
      const classFit = src.byClass?.[`${tag}:${row.role}`];
      sum += own ? own.delta : classFit?.delta ?? src.unplayed ?? 0;
      games += own?.games || classFit?.games || 0;
    }
    const cap = PERSONAL_CAP * ix.sd;
    const delta = Math.max(-cap, Math.min(cap, PERSONAL_WEIGHT * sum));
    if (!delta) return { ...row, personal: 0, personalGames: games };
    const logit = row.logit + delta;
    const score = Math.round(toScore(ix, logit));
    return { ...row, logit, score, personal: score - row.score, personalGames: games, parts: { ...row.parts, personal: delta } };
  }

  /**
   * What the board does to a typical pick in role r: popularity-weighted averages, over the
   * champions usually played there, of the board terms, the rest of the draft and the
   * enemy's answers. Cached per board.
   */
  function typical(ix, r, allies, enemies, rest, unavailable) {
    const ids = (list) => list.map((p) => `${asPick(p).championId}:${asPick(p).position || ''}`).join(',');
    const key = `${r}|${ids(allies)}|${ids(enemies)}|${rest ? 1 : 0}|${rest?.answerShare ?? 1}|${[...unavailable].sort().join(',')}`;
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
    const row = { ...a.row, logit, score: Math.round(toScore(ix, logit)), parts: { ...a.row.parts, typical: -typ.board } };
    if (!rest) return row;
    // Look-ahead terms count by the evidence behind this champion in this role
    const rel = a.row.games / (a.row.games + ix.priorGames);
    const withFuture = logit + rel * (a.ahead - typ.ahead);
    const final = withFuture - rel * (a.exposure - typ.exposure);
    const score = Math.round(toScore(ix, final));
    const parts = { ...row.parts, ahead: rel * (a.ahead - typ.ahead), exposure: -rel * (a.exposure - typ.exposure) };
    return { ...row, logit: final, score, parts, counterRisk: Math.round(toScore(ix, withFuture)) - score };
  }

  /**
   * How many champions a player can safely play in a role: those with results above their
   * own level (delta > 0) or high mastery, each counted by how many games back it up
   * (POOL_GAMES for a full one). entries: [{ games, delta, mastery }] for that role.
   */
  function poolDepth(entries) {
    return (entries || []).reduce((n, e) => n + ((e.delta > 0 || e.mastery >= POOL_MASTERY) ? Math.min(1, e.games / POOL_GAMES) : 0), 0);
  }

  // Solo lanes (top, middle) with a narrow pool pick later, with a deep one earlier; no
  // data on the player, no shift
  function poolShift(pick) {
    if (pick.poolDepth === null || pick.poolDepth === undefined) return 0;
    if (pick.p.position !== 'top' && pick.p.position !== 'middle') return 0;
    return POOL_WEIGHT * (1 / (1 + pick.poolDepth) - 1 / (1 + POOL_NORMAL));
  }

  function orderPickSuggestions(rated, enemyPicks = [], model = null, knownAllies = []) {
    const roleBias = { jungle: 0, utility: 0, bottom: 2, middle: 8, top: 10 };
    const ix = has(model) ? index(model) : null;
    const ownPicks = [...knownAllies.map(asPick), ...rated.map((pick) => ({ championId: pick.championId, position: pick.p.position }))];
    const assignments = ix ? roleAssignments(ix, enemyPicks, ownPicks) : [];
    const roleProbability = (role) => assignments.reduce((sum, assignment) =>
      sum + (assignment.roles.includes(role) ? assignment.probability : 0), 0);
    const botRoles = new Set([ROLE_INDEX.bottom, ROLE_INDEX.utility]);
    const priority = (pick) => {
      const role = ROLE_INDEX[pick.p.position];
      const matchup = Math.min(8, Math.max(0, pick.matchup || 0));
      const targetProbability = role === ROLE_INDEX.bottom || role === ROLE_INDEX.utility
        ? Math.min(1, [...botRoles].reduce((sum, targetRole) => sum + roleProbability(targetRole), 0))
        : roleProbability(role);
      // The opposing champion is on the board: we pick right after it, to counter it
      const counterBonus = targetProbability * (role === ROLE_INDEX.jungle
        ? 22 + Math.min(6, matchup)
        : 30 + matchup);
      const personalProtection = Math.min(4, Math.max(0, (pick.personal || 0) * 0.5));
      return (pick.risk ?? 0) + (roleBias[pick.p.position] ?? 0) + personalProtection + poolShift(pick) - counterBonus;
    };
    return rated.map((pick) => ({ ...pick, orderPriority: priority(pick) }))
      .sort((a, b) => a.orderPriority - b.orderPriority);
  }

  /**
   * A pick order planned slot by slot. remaining: the teammates still to pick, in the
   * client's order ({ p: { cellId, position }, poolDepth }); sequence: pickSequence of the
   * draft. Every (player, slot) pair has a cost in points:
   *   blind risk   how exposed the role is to a counter (PICK_BLIND, top and mid most) while
   *                its opponent is still unseen: the chance the opponent has shown by that slot
   *                comes from the enemy picks that happen before it
   *   pool         a narrow pool on a solo lane makes that exposure worse
   *   eagerness    an opponent already on the board is countered right away, so those roles
   *                go first (PICK_EAGER points per slot of waiting)
   *   trade        a small cost per slot of distance from the client's order, so it only
   *                moves people when it pays
   * Returns { order: cell ids, costOf(order) } with the cheapest assignment; costOf lets the
   * caller see how much a change is worth before making it.
   */
  function planPickOrder({ model, remaining, enemyPicks = [], sequence = [], lockedAllies = [] }) {
    const ix = has(model) ? index(model) : null;
    const assignments = ix ? roleAssignments(ix, enemyPicks, lockedAllies) : [];
    const roleProbability = (role) => (ix
      ? assignments.reduce((sum, a) => sum + (a.roles.includes(role) ? a.probability : 0), 0)
      : (enemyPicks.some((p) => ROLE_INDEX[asPick(p).position] === role) ? 1 : 0));
    const visible = (position) => {
      const role = ROLE_INDEX[position];
      if (role === ROLE_INDEX.bottom || role === ROLE_INDEX.utility) return Math.min(1, roleProbability(ROLE_INDEX.bottom) + roleProbability(ROLE_INDEX.utility));
      return Math.min(1, roleProbability(role));
    };
    const pending = sequence.filter((x) => !x.ally && !x.completed);
    const slotRound = (cellId) => sequence.find((x) => x.ally && !x.completed && x.cellId === cellId)?.round;
    const slots = remaining.map((r) => {
      const round = slotRound(r.p.cellId);
      const revealed = round === undefined ? 0 : pending.filter((x) => x.round < round).length;
      return pending.length ? revealed / pending.length : 0;
    });
    const byCell = new Map(remaining.map((r, i) => [r.p.cellId, { r, home: i }]));
    const cost = (cellId, slot) => {
      const { r, home } = byCell.get(cellId);
      const now = visible(r.p.position);
      const seen = now + (1 - now) * slots[slot];
      let blind = PICK_BLIND[r.p.position] ?? 3;
      if ((r.p.position === 'top' || r.p.position === 'middle') && r.poolDepth !== null && r.poolDepth !== undefined) {
        blind += POOL_WEIGHT * (1 / (1 + r.poolDepth) - 1 / (1 + POOL_NORMAL));
      }
      return Math.max(0, blind) * (1 - seen) + PICK_EAGER * now * slot + PICK_TRADE * Math.abs(home - slot);
    };
    const costOf = (order) => order.reduce((sum, cellId, slot) => sum + cost(cellId, slot), 0);
    let best = null;
    const walk = (left, acc) => {
      if (!left.length) {
        const c = costOf(acc);
        if (!best || c < best.c - 1e-9) best = { order: acc, c };
        return;
      }
      left.forEach((cellId, i) => walk([...left.slice(0, i), ...left.slice(i + 1)], [...acc, cellId]));
    };
    walk(remaining.map((r) => r.p.cellId), []);
    return { order: best ? best.order : [], costOf };
  }

  function pickOrderImprovement(current, desired, rated) {
    if (!Array.isArray(current) || !current.length) return Infinity;
    const priorities = new Map(rated.map((pick) => [pick.p.cellId, pick.orderPriority]));
    const utility = (order) => order.reduce((sum, cellId, i) => sum + i * (priorities.get(cellId) || 0), 0);
    return utility(desired) - utility(current);
  }

  function pickOrderTrades(rated, suggested, simultaneousPickGroups = []) {
    const simultaneousGroup = new Map();
    simultaneousPickGroups.forEach((group, i) => group.forEach((cellId) => simultaneousGroup.set(cellId, i)));
    const trades = [];
    rated.forEach((r, i) => {
      const next = suggested[i];
      if (!next || next.p === r.p) return;
      if (simultaneousGroup.has(r.p.cellId) && simultaneousGroup.get(r.p.cellId) === simultaneousGroup.get(next.p.cellId)) return;
      if (!trades.some((trade) => trade.includes(r.p) || trade.includes(next.p))) trades.push([r.p, next.p]);
    });
    return trades.slice(0, 2);
  }

  function shouldUpdatePickOrder(initialized, turn) {
    if (!initialized) return !(turn?.side === 'ally' && turn.kind === 'pick');
    return turn?.side === 'enemy' && turn.kind === 'pick';
  }

  function shouldUpdatePickOrderForHover(turn, teammateHoverChanged) {
    return turn?.side === 'ally' && turn.kind === 'pick' && teammateHoverChanged;
  }

  function stabilizePickOrder(previous, pending, desired, now, delay = 1500, allowChange = true, improvement = Infinity, threshold = 2.5) {
    const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((id, i) => id === b[i]);
    if (!allowChange) return { order: Array.isArray(previous) ? previous : [], pending: null };
    if (!Array.isArray(previous) || !previous.length || same(previous, desired)) return { order: desired, pending: null };
    if (improvement < threshold) return { order: previous, pending: null };
    if (!pending || !same(pending.order, desired)) return { order: previous, pending: { order: desired, since: now } };
    if (now - pending.since >= delay) return { order: desired, pending: null };
    return { order: previous, pending };
  }

  /** Same arguments and result as Recommend.recommend, plus model. Scores look ahead (see above). */
  function recommend({ model, role = '', unavailable = new Set(), pickable = null, allies = [], enemies = [], pool = [], limit = 10, personal = null, answerShare = 1 }) {
    const ix = index(model);
    const allowed = pickable ? new Set(pickable) : null;
    const inPool = new Set(pool);
    const rests = new Map();
    const restFor = (r) => {
      if (!rests.has(r)) rests.set(r, restOfDraft(ix, r, allies, enemies, unavailable, answerShare));
      return rests.get(r);
    };
    const out = [];
    for (const [championId, best] of ix.bestRole) {
      if (unavailable.has(championId) || (allowed && !allowed.has(championId))) continue;
      const r = role ? ROLE_INDEX[role] : best.r;
      const entry = ix.champ.get(`${championId}:${r}`);
      // Never seen in this role, or off-meta there: not recommended (see above)
      if (!entry || (ix.matches && entry.games / (2 * ix.matches) < MIN_PICK_RATE)) continue;
      const rest = ix.matches ? restFor(r) : null;
      const typ = typical(ix, r, allies, enemies, rest, unavailable);
      const row = finalRow(ix, assess(ix, championId, r, allies, enemies, rest), typ, rest);
      const blind = ix.blindability.get(`${championId}:${r}`);
      out.push({
        ...personalize(ix, { counterRisk: 0, ...row }, personal),
        blindSpread: blind?.spread ?? null,
        counterRate: blind?.counterRate ?? null,
        counterChance: blind?.counterChance ?? null,
        inPool: inPool.has(championId),
      });
    }
    return out.sort((x, y) => y.logit - x.logit || y.games - x.games).slice(0, limit);
  }

  /**
   * Same arguments and result as Recommend.evaluate, plus model. With lookAhead the score
   * takes the rest of the draft into account like recommend() (for a pick not locked yet).
   */
  function evaluate({ model, championId, role = '', allies = [], enemies = [], lookAhead: ahead = false, unavailable = new Set(), personal = null, answerShare = 1 }) {
    const ix = index(model);
    if (!ix.bestRole.has(championId)) return null;
    const r = role ? ROLE_INDEX[role] : ix.bestRole.get(championId).r;
    const rest = ahead && ix.matches ? restOfDraft(ix, r, allies, enemies, unavailable, answerShare) : null;
    const typ = typical(ix, r, allies, enemies, rest, unavailable);
    const row = finalRow(ix, assess(ix, championId, r, allies, enemies, rest), typ, rest);
    const blind = ix.blindability.get(`${championId}:${r}`);
    return {
      ...personalize(ix, ahead ? { counterRisk: 0, ...row } : row, personal),
      blindSpread: blind?.spread ?? null,
      counterRate: blind?.counterRate ?? null,
      counterChance: blind?.counterChance ?? null,
    };
  }

  /**
   * Ban suggestions: { model, unavailable, allies, enemies, limit }. allies are our
   * picks and pick intents, enemies the enemy's locked picks (both { championId, position }).
   * Returns [{ championId, score, role, pickChance, value }], best ban first.
   */
  /**
   * Our team's win chance with this final draft, split into where it comes from (each part
   * in log-odds, from our side): champions (strength and off-role), synergy (pairs on each
   * team), matchups (every pair across the teams) and composition (team styles).
   * allies / enemies: five { championId, position } each.
   */
  function winParts({ model, allies, enemies }) {
    const ix = index(model);
    const team = (list) => list.map(asPick).map((p) => ({ c: p.championId, r: roleIndex(ix, p.championId, p.position) })).filter((p) => p.r !== null);
    const us = team(allies);
    const them = team(enemies);
    const side = (t) => {
      const out = { champions: 0, synergy: 0, composition: 0 };
      t.forEach((p, i) => {
        const e = ix.champ.get(`${p.c}:${p.r}`);
        out.champions += (e ? e.w : 0) + ix.off[p.r] * -Math.log(Math.max(e ? e.share : 0, ix.floor));
        for (let j = i + 1; j < t.length; j++) out.synergy += synergy(ix, p.c, p.r, t[j].c, t[j].r);
      });
      if (ix.comp) {
        const T = styleOf(ix, t.map((p) => p.c));
        for (let k = 0; k < T.length; k++) out.composition += ix.comp.a[k] * Math.tanh(T[k] + ix.comp.c[k]);
      }
      return out;
    };
    const a = side(us);
    const b = side(them);
    let matchups = 0;
    for (const x of us) for (const y of them) matchups += matchup(ix, x.c, x.r, y.c, y.r);
    let composition = a.composition - b.composition + pillarValue(ix, us.map((p) => p.c), them.map((p) => p.c))
      + ix.sd * (teamFit(ix, them.map((p) => p.c)).penalty - teamFit(ix, us.map((p) => p.c)).penalty);
    if (ix.comp) {
      const A = styleOf(ix, us.map((p) => p.c));
      const B = styleOf(ix, them.map((p) => p.c));
      for (let k = 0; k < A.length; k++) for (let j = 0; j < A.length; j++) composition += A[k] * ix.comp.M[k][j] * B[j];
    }
    const parts = { champions: a.champions - b.champions, synergy: a.synergy - b.synergy, matchups, composition };
    return { ...parts, logit: parts.champions + parts.synergy + parts.matchups + parts.composition };
  }

  /** Probability that our team wins with this final draft (winParts added up) */
  function winChance(args) {
    return 1 / (1 + Math.exp(-winParts(args).logit));
  }

  // Log-odds as percentage points of win chance around an even game
  const pct = (z) => (100 / (1 + Math.exp(-z))) - 50;

  /**
   * A game plan from the final draft, every number read off the model, all in percentage
   * points of win chance so they can be compared:
   *   winChance  the whole draft; parts: champions, synergy, matchups, composition
   *   lanes      per role, the lane result of our champion against theirs as an average
   *              player gets it: the learned lane matchup (early.laneVs) when it has
   *              games, else the two champions' average lanes (early.laneMean). A lane is
   *              ahead or behind beyond LANE_CALL standard deviations of its role.
   *   objectives what the two drafts do to the first objectives (early.objMean)
   *   early      lanes and objectives together: the draft's edge in the first minutes
   *   later      the rest of the draft's edge (win chance minus early): what it does after
   *   edge       percentage points from which an edge is worth naming (EDGE_PCT)
   *   focus/weak the lane we are most ahead / behind in, when called
   *   damage     each team's magic share (Data Dragon ratings), when given
   * Returns null without the early game model.
   */
  function gamePlan({ model, allies, enemies, damage = null }) {
    const ix = index(model);
    const tools = laneTools(ix);
    if (!tools) return null;
    const { sdOf, laneOf } = tools;
    const roleOf = (p) => roleIndex(ix, asPick(p).championId, asPick(p).position);
    const byRole = (list) => {
      const out = new Array(5).fill(null);
      for (const p of list.map(asPick)) {
        const r = roleOf(p);
        if (r !== null && !out[r]) out[r] = p.championId;
      }
      return out;
    };
    const us = byRole(allies);
    const them = byRole(enemies);
    const lanes = ROLES.map((role, r) => {
      if (!us[r] || !them[r]) return null;
      const { diff, games } = laneOf(r, us[r], them[r]);
      const cut = LANE_CALL * sdOf[r];
      return { role, ours: us[r], theirs: them[r], diff, pct: pct(diff), games, call: diff > cut ? 'ahead' : diff < -cut ? 'behind' : 'even' };
    });
    const known = lanes.filter(Boolean);
    const obj = model.early.objMean || {};
    const objSide = (ids) => ids.reduce((a, c, r) => a + (c ? obj[`${c}:${r}`] ?? 0 : 0), 0);
    const objectives = objSide(us) - objSide(them);
    const earlyLogit = known.reduce((a, l) => a + l.diff, 0) + objectives;
    const parts = winParts({ model, allies, enemies });
    const later = parts.logit - earlyLogit;
    const early = pct(earlyLogit);
    const laterPct = pct(later);
    const ahead = known.filter((l) => l.call === 'ahead').sort((a, b) => b.diff - a.diff)[0] || null;
    const behind = known.filter((l) => l.call === 'behind').sort((a, b) => a.diff - b.diff)[0] || null;
    const magic = (list) => {
      if (!damage) return null;
      const ids = list.map((p) => asPick(p).championId);
      return ids.reduce((a, c) => a + (damage.magic[c] ?? 0.5), 0) / ids.length;
    };
    return {
      winChance: 1 / (1 + Math.exp(-parts.logit)),
      parts: { champions: pct(parts.champions), synergy: pct(parts.synergy), matchups: pct(parts.matchups), composition: pct(parts.composition) },
      lanes,
      objectives: pct(objectives),
      early,
      later: laterPct,
      edge: EDGE_PCT,
      focus: ahead ? ahead.role : null,
      weak: behind ? behind.role : null,
      damage: damage ? { ours: magic(allies), theirs: magic(enemies) } : null,
    };
  }

  /**
   * Ban suggestions. history: { championId: [games, wins] } of the team's past games with
   * this exact five against each champion (wins are ours); what beat them counts next to
   * the model's value, by how many games it rests on.
   */
  function recommendBans({ model, unavailable = new Set(), allies = [], enemies = [], limit = 10, history = null }) {
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
      // What this five has lost to: log-odds of losing, shrunk to even by 4 games, by evidence
      const past = history?.[championId];
      let beat = 0;
      if (past && past[0] > 0) {
        const rate = (past[1] + HISTORY_PRIOR) / (past[0] + 2 * HISTORY_PRIOR);
        beat = (past[0] / (past[0] + HISTORY_CONFIDENCE)) * Math.min(HISTORY_CAP, Math.max(0, -Math.log(rate / (1 - rate))));
      }
      value += beat * (main ? Math.max(main.p, HISTORY_PICK_FLOOR) : HISTORY_PICK_FLOOR);
      if (value <= 0) continue;
      out.push({
        championId,
        value,
        score: Math.round(100 * (1 - Math.exp(-value / (BAN_UNIT * ix.sd)))),
        role: ROLES[main ? main.r : ix.bestRole.get(championId).r],
        pickChance: main ? main.p : 0,
        history: past ? { games: past[0], wins: past[1] } : null,
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

  /**
   * The personal layer of a player for this draft: their season and patch statistics, and
   * those with the team members on their side now (lineup: their player ids, the player
   * included). playerStats: { playerId: { season, history, team: { "<sorted ids>": stats } } }
   */
  function personalFor(playerStats, playerId, lineup = [], classOf = () => 'None') {
    const own = playerId && playerStats?.[playerId];
    if (!own) return null;
    const ids = [...new Set([playerId, ...lineup.filter(Boolean)])].sort();
    const shrinkClasses = (source) => {
      if (!source) return source;
      const pooled = new Map();
      for (const [key, value] of Object.entries(source.byKey || {})) {
        const [champion, role] = key.split(':');
        const tag = classOf(Number(champion)) || 'None';
        if (tag === 'None' || !role) continue;
        const groupKey = `${tag}:${role}`;
        const group = pooled.get(groupKey) || { weightedDelta: 0, games: 0 };
        const games = Math.max(0, Number(value.games) || 0);
        group.weightedDelta += (Number(value.delta) || 0) * games;
        group.games += games;
        pooled.set(groupKey, group);
      }
      if (!pooled.size) return source;
      return {
        ...source,
        byClass: Object.fromEntries([...pooled].map(([key, group]) => [key, {
          delta: group.weightedDelta / (group.games + PERSONAL_CLASS_PRIOR),
          games: group.games,
        }])),
      };
    };
    return {
      season: shrinkClasses(own.season),
      history: shrinkClasses(own.history),
      team: ids.length > 1 ? shrinkClasses(own.team?.[ids.join(',')]) : undefined,
    };
  }

  /**
   * Who should play which role when the five on our side are all team members (in the
   * lobby or queue). members: [{ id, roles?, preferences? }] (roles: what the player chose in
   * the Team tab, preferences: what they picked in the lobby); playerStats as in personalFor.
   * Every player gets a value for every role from their statistics there, each source
   * weighted: the season, this patch, and the games with exactly this line-up (the heaviest,
   * the same five on the same roles). Each source gives the games-weighted champion delta
   * (shrunk by ROLE_PRIOR games), how much of their games the role is, and the depth of their
   * pool in it. The best of all 120 assignments wins; points are on the model's scale.
   * Returns { options: [{ total, picks: [{ id, role, points, games, champions, parts }] }], margin } or null.
   */
  function lineupRoles({ model, members, playerStats }) {
    if (!Array.isArray(members) || members.length !== 5) return null;
    const sd = has(model) ? index(model).sd : 0.1;
    const toPoints = (x) => Math.round(50 * Math.tanh((SPREAD * x) / sd));
    const key = members.map((m) => m.id).sort().join(',');
    const WEIGHT = { season: 1, history: 0.8, team: 1.6 };

    const cell = (m, role) => {
      const own = playerStats?.[m.id] || {};
      const parts = {};
      let sum = 0;
      let weight = 0;
      const seen = new Map(); // champion -> games, to show their most played
      for (const source of ['season', 'history', 'team']) {
        const src = source === 'team' ? own.team?.[key] : own[source];
        if (!src?.byKey) continue;
        const all = Object.entries(src.byKey);
        const total = all.reduce((a, [, e]) => a + e.games, 0);
        const here = all.filter(([k]) => k.split(':')[1] === role).map(([k, e]) => ({ championId: Number(k.split(':')[0]), ...e }));
        const games = here.reduce((a, e) => a + e.games, 0);
        let value;
        if (!games) {
          // Known player, never on this role: what an unplayed champion costs, and a part for the role itself
          value = (src.unplayed || 0) - (total >= 10 ? NEW_ROLE * sd * (total / (total + 10)) : 0);
        } else {
          const delta = here.reduce((a, e) => a + e.games * e.delta, 0) / (games + ROLE_PRIOR);
          const share = (games / total - 0.2) / 0.4;
          const depth = poolDepth(here);
          value = delta + ROLE_EXPERIENCE * sd * Math.max(-0.5, Math.min(1, share)) + POOL_DEPTH * sd * (Math.min(depth, 5) - 2) / 3;
        }
        parts[source] = { points: toPoints(value), games };
        sum += WEIGHT[source] * value;
        weight += WEIGHT[source];
        for (const e of here) seen.set(e.championId, (seen.get(e.championId) || 0) + e.games);
      }
      let value = weight ? sum / weight : 0;
      const chosen = m.roles || [];
      if (chosen.length) value += (chosen.includes(role) ? 1 : -1) * ROLE_CHOICE * sd;
      if ((m.preferences || []).includes(role)) value += ROLE_CHOICE * 0.5 * sd;
      const champions = [...seen].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
      return { value, parts, games: Object.values(parts).reduce((a, p) => Math.max(a, p.games), 0), champions };
    };

    const cells = members.map((m) => ROLES.map((role) => cell(m, role)));
    const ranked = PERMUTATIONS
      .map((perm) => ({ perm, total: perm.reduce((a, r, i) => a + cells[i][r].value, 0) }))
      .sort((a, b) => b.total - a.total);
    const options = ranked.slice(0, 3).map(({ perm, total }) => ({
      total: toPoints(total / 5) * 5,
      picks: perm.map((r, i) => ({
        id: members[i].id,
        role: ROLES[r],
        points: toPoints(cells[i][r].value),
        games: cells[i][r].games,
        champions: cells[i][r].champions,
        parts: cells[i][r].parts,
      })),
    }));
    return { options, margin: options.length > 1 ? options[0].total - options[1].total : 0 };
  }

  function metaFallbackStats(stats) {
    if (!stats?.meta?.length) return null;
    const sourceRows = (rows) => (rows || []).filter((row) => !row.source || row.source === 'metasrc');
    const meta = sourceRows(stats.meta);
    if (!meta.length) return null;
    return { meta, synergy: sourceRows(stats.synergy), matchup: sourceRows(stats.matchup) };
  }

  function modelConfidence(model) {
    if (!model) return 0;
    const matches = model.matches || 0;
    const strength = matches > 0 ? Math.min(1, Math.max(0.2, matches / 20000)) : 0.5;
    const synergy = Math.min(1, (model.syn?.length || 0) / 200);
    const matchup = Math.min(1, (model.vs?.length || 0) / 200);
    return 0.4 * strength + 0.3 * synergy + 0.3 * matchup;
  }

  // How fresh the model is for the current patch, 0-1: a patch under two days old, or with
  // few matches, leans on older patches. Unknown (no patch data): fully trusted.
  function patchFreshness(model) {
    const matches = Number(model?.patchMatches);
    if (!Number.isFinite(matches)) return 1;
    const patchStartedAt = Date.parse(model.patchStartedAt || '');
    if (Number.isFinite(patchStartedAt) && Math.max(0, Date.now() - patchStartedAt) < 48 * 60 * 60 * 1000) return 0.25;
    return 0.25 + 0.75 * Math.min(1, Math.max(0, matches) / 10000);
  }

  /**
   * Share of the model against MetaSRC for one pick: how much the model knows about this
   * champion in this role (its games there), times how well trained and current it is
   * overall. A well-covered pick is the model alone (1); a pick it has barely seen, or a
   * model that is small or new, hands over to MetaSRC (down to 0). Nothing else caps it:
   * where the model has the evidence, MetaSRC has no say.
   */
  function sourceWeights(model, games = null) {
    const evidence = games === null ? 1 : 1 - Math.exp(-Math.max(0, games) / ROLE_EVIDENCE_GAMES);
    let w = Math.min(1, modelConfidence(model) * patchFreshness(model) * evidence);
    if (w >= 0.95) w = 1;
    if (w <= 0.05) w = 0;
    return { model: w, metasrc: 1 - w };
  }

  function calibratedMetaScore(modelRow, args, weights) {
    const calibration = args.model?.ensemble?.metaCalibration;
    const rows = metaFallbackStats(args.stats)?.meta || [];
    if (!args.model?.ensemble?.supported || !calibration || !rows.length || !Number.isFinite(modelRow.logit)) return null;
    const scores = Array.from({ length: 5 }, () => new Map());
    const roleValues = Array.from({ length: 5 }, () => []);
    for (const row of rows) {
      const role = ROLE_INDEX[row.role];
      const score = Number(row.score);
      if (role === undefined || !Number.isFinite(score)) continue;
      scores[role].set(row.champion_id, score);
      roleValues[role].push(score);
    }
    const strength = (champion, role) => {
      const value = scores[role].get(champion);
      if (value === undefined || !roleValues[role].length) return 0;
      const values = roleValues[role];
      const mean = values.reduce((sum, item) => sum + item, 0) / values.length;
      const sd = Math.sqrt(values.reduce((sum, item) => sum + (item - mean) ** 2, 0) / values.length) || 1;
      return (value - mean) / sd;
    };
    const source = metaFallbackStats(args.stats);
    const synergy = (a, ra, b) => {
      const direct = source.synergy.find((row) => row.champion_id === a && ROLE_INDEX[row.role] === ra && row.ally_id === b);
      const reverse = source.synergy.find((row) => row.champion_id === b && row.ally_id === a);
      const values = [direct, reverse].filter(Boolean).map((row) => Number(row.strength)).filter(Number.isFinite);
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    };
    const matchup = (a, ra, b, rb) => {
      const direct = source.matchup.find((row) => row.champion_id === a && ROLE_INDEX[row.role] === ra && row.opponent_id === b && ROLE_INDEX[row.opponent_role || row.role] === rb);
      if (direct) return Number(direct.strength);
      const reverse = source.matchup.find((row) => row.champion_id === b && row.opponent_id === a && ROLE_INDEX[row.role] === rb);
      return reverse ? -Number(reverse.strength) : 0;
    };
    const ownPicks = [{ championId: modelRow.championId, position: modelRow.role }, ...(args.allies || []).map(asPick)];
    const enemyPicks = (args.enemies || []).map(asPick);
    const ix = index(args.model);
    const ownAssignments = roleAssignments(ix, ownPicks);
    const enemyAssignments = roleAssignments(ix, enemyPicks, ownPicks);
    const totals = [0, 0, 0];
    let probabilitySum = 0;
    for (const own of ownAssignments) for (const enemy of enemyAssignments) {
      const probability = own.probability * enemy.probability;
      const ownTeam = new Array(5).fill(null);
      const enemyTeam = new Array(5).fill(null);
      ownPicks.forEach((pick, i) => { ownTeam[own.roles[i]] = pick.championId; });
      enemyPicks.forEach((pick, i) => { enemyTeam[enemy.roles[i]] = pick.championId; });
      for (let role = 0; role < 5; role++) {
        if (ownTeam[role]) totals[0] += probability * strength(ownTeam[role], role);
        if (enemyTeam[role]) totals[0] -= probability * strength(enemyTeam[role], role);
        for (let other = role + 1; other < 5; other++) {
          if (ownTeam[role] && ownTeam[other]) totals[1] += probability * synergy(ownTeam[role], role, ownTeam[other]);
          if (enemyTeam[role] && enemyTeam[other]) totals[1] -= probability * synergy(enemyTeam[role], role, enemyTeam[other]);
        }
        for (let enemyRole = 0; enemyRole < 5; enemyRole++) {
          if (ownTeam[role] && enemyTeam[enemyRole]) totals[2] += probability * matchup(ownTeam[role], role, enemyTeam[enemyRole], enemyRole);
        }
      }
      probabilitySum += probability;
    }
    const features = probabilitySum ? totals.map((value) => value / probabilitySum) : totals;
    const metaLogit = calibration.weights[0] + features.reduce((sum, value, i) =>
      sum + calibration.weights[i + 1] * ((value - calibration.mean[i]) / calibration.sd[i]), 0);
    if (!Number.isFinite(metaLogit)) return null;
    const blendedLogit = weights.model * modelRow.logit + weights.metasrc * metaLogit;
    return Math.round(100 / (1 + Math.exp(-Math.max(-30, Math.min(30, blendedLogit)))));
  }

  function withMetaFallback(modelRow, metaRow, model, args) {
    if (!modelRow) return metaRow;
    if (!metaRow) return modelRow;
    const weights = sourceWeights(model, modelRow.games ?? null);
    return {
      ...modelRow,
      score: calibratedMetaScore(modelRow, args, weights) ?? Math.round(weights.model * modelRow.score + weights.metasrc * metaRow.score),
      modelScore: modelRow.score,
      metaSrcScore: metaRow.score,
      weights,
      allies: modelRow.allies?.length ? modelRow.allies : metaRow.allies,
      enemies: modelRow.enemies?.length ? modelRow.enemies : metaRow.enemies,
    };
  }

  function hybridEvaluate(args) {
    const sourceStats = metaFallbackStats(args.stats);
    const modelRow = has(args.model) ? evaluate(args) : null;
    const metaRow = sourceStats && root.Recommend
      ? root.Recommend.evaluate({ ...args, stats: sourceStats, allies: (args.allies || []).map((pick) => asPick(pick).championId) })
      : null;
    return withMetaFallback(modelRow, metaRow, args.model, args);
  }

  function hybridRecommend(args) {
    const sourceStats = metaFallbackStats(args.stats);
    if (!has(args.model)) return sourceStats && root.Recommend
      ? root.Recommend.recommend({ ...args, stats: sourceStats, allies: (args.allies || []).map((pick) => asPick(pick).championId) })
      : [];
    const modelRows = recommend(args);
    if (!sourceStats || !root.Recommend) return modelRows;
    const metaRows = root.Recommend.recommend({ ...args, stats: sourceStats, allies: (args.allies || []).map((pick) => asPick(pick).championId) });
    const metaByKey = new Map(metaRows.map((row) => [`${row.championId}:${row.role}`, row]));
    return modelRows.map((row) => withMetaFallback(row, metaByKey.get(`${row.championId}:${row.role}`), args.model, args))
      .sort((a, b) => b.score - a.score || b.logit - a.logit)
      .slice(0, args.limit || modelRows.length);
  }

  /**
   * Share of the enemy's picks still to come that happen after this cell's pick, so they
   * can see it (1 when unknown: assume every answer is possible). sequence: pickSequence
   * of the draft, [{ cellId, ally, completed, round }].
   */
  function answerShare(sequence, cellId) {
    const mine = (sequence || []).find((x) => x.cellId === cellId && x.ally && !x.completed);
    const pending = (sequence || []).filter((x) => !x.ally && !x.completed);
    if (!mine || !pending.length) return 1;
    return pending.filter((x) => x.round > mine.round).length / pending.length;
  }

  const Engine = {
    recommend: hybridRecommend,
    evaluate: hybridEvaluate,
    orderPickSuggestions,
    planPickOrder,
    roleDistribution,
    pickOrderImprovement,
    pickOrderTrades,
    shouldUpdatePickOrder,
    shouldUpdatePickOrderForHover,
    answerShare,
    poolDepth,
    stabilizePickOrder,
    // Bans need the learned model; without one there are no suggestions
    recommendBans: (args) => (has(args.model) ? recommendBans(args) : []),
    guessRoles: (args) => (has(args.model) && args.players.length === 5 ? guessRoles(args) : null),
    // A change in log-odds as points around a typical pick (50), on the model's scale
    points: (model, delta) => (has(model) ? Math.round(toScore(index(model), delta) - 50) : 0),
    gamePlan: (args) => (has(args.model) ? gamePlan(args) : null),
    lineupRoles,
    personalFor,
  };

  const api = { recommend, evaluate, recommendBans, guessRoles, gamePlan, winChance, winParts, personalFor, lineupRoles, Engine, ROLES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
