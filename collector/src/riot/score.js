// Computes meta score, synergy and matchup from the raw counters (riot_*_stats). Pure function.
//
// META (champion × role, 0-100)
//   Adjusted WR = (wins + K × role average) / (games + K)
//     A low-sample champion's WR is pulled toward the role average; 58% over 50 games counts as ~52%.
//   Pick rate = games / matches · Ban rate = bans / matches × (champion's share in this role)
//   All three become z-scores within the role (square root of pick and ban rate, so outliers don't dominate):
//     composite = 0.60·z(WR) + 0.25·z(pick) + 0.15·z(ban)
//     score     = 50 + 12 × composite   (clamped to 0-100; the role average is 50)
//
// SYNERGY (A in this role, B on the same team)
//   Expected WR = σ(logit WR_A + logit WR_B)      from each champion's own strength
//     (these WRs use a lighter adjustment, baselinePriorGames. With the strong meta
//      adjustment every pair of a strong champion would get fake synergy.)
//   Observed = (wins + K' × expected) / (games + K')   pulled toward expected on little data
//   Strength = (observed - expected) / 5 points, -1..1 (negative: the pair does worse together)
//   A strong champion looks good with everyone; the deviation from expected filters that out.
//
// MATCHUP (A in this role, B on the enemy team in its role)
//   Same lane from riot_lane_stats, other roles from riot_vs_stats (e.g. bot vs enemy support).
//   Expected WR = σ(logit WR_A - logit WR_B) · Strength = deviation / 6 points, -1..1

const CONFIG = {
  weights: { winRate: 0.6, pickRate: 0.25, banRate: 0.15 },
  scoreScale: 12, // composite of 1 standard deviation = 12 points
  priorGames: 200, // virtual games pulling the meta WR toward the role average
  minGames: 30, // minimum games to appear in meta
  baselinePriorGames: 50, // adjustment of the WR used for "expected" in synergy/matchup
  pairPriorGames: 100, // virtual games pulling a pair's deviation toward zero
  pairMinGames: 15,
  synergyFull: 0.05, // +5 points deviation = full synergy (1.0)
  matchupFull: 0.06, // ±6 points deviation = full strong/weak (±1.0)
  minStrength: 0.05, // weaker relations are not written
  tiers: [['S', 70], ['A', 60], ['B', 50], ['C', 40], ['D', -Infinity]],
};

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

function zScores(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return values.map((v) => (sd > 0 ? (v - mean) / sd : 0));
}

/**
 * @param {{ matches:number, champ:object[], bans:object[], duo:object[], lane:object[], vs?:object[] }} agg
 * @returns {{ meta: object[], synergy: object[], matchup: object[] }}  (normalize.js format)
 */
function score(agg, config = CONFIG) {
  const c = config;
  const matches = agg.matches || 0;
  if (!matches) return { meta: [], synergy: [], matchup: [] };

  // Role averages and each champion's total games
  const roleTotals = new Map();
  const champTotals = new Map();
  for (const r of agg.champ) {
    const t = roleTotals.get(r.role) || { games: 0, wins: 0 };
    roleTotals.set(r.role, { games: t.games + r.games, wins: t.wins + r.wins });
    const ct = champTotals.get(r.champion_id) || { games: 0, wins: 0 };
    champTotals.set(r.champion_id, { games: ct.games + r.games, wins: ct.wins + r.wins });
  }
  const roleMean = (role) => {
    const t = roleTotals.get(role);
    return t && t.games ? t.wins / t.games : 0.5;
  };
  const bans = new Map(agg.bans.map((b) => [b.champion_id, b.bans]));

  // Adjusted WR: strong adjustment for meta (priorGames),
  // light adjustment for the "expected" value of synergy/matchup (baselinePriorGames)
  const wrRole = new Map();
  const baseRole = new Map();
  for (const r of agg.champ) {
    const mu = roleMean(r.role);
    wrRole.set(`${r.champion_id}:${r.role}`, (r.wins + c.priorGames * mu) / (r.games + c.priorGames));
    baseRole.set(`${r.champion_id}:${r.role}`, (r.wins + c.baselinePriorGames * mu) / (r.games + c.baselinePriorGames));
  }
  const baseOverall = (id) => {
    const t = champTotals.get(id) || { games: 0, wins: 0 };
    return (t.wins + c.baselinePriorGames * 0.5) / (t.games + c.baselinePriorGames);
  };
  const wrIn = (id, role) => baseRole.get(`${id}:${role}`) ?? baseOverall(id);

  // META
  const meta = [];
  const byRole = new Map();
  for (const r of agg.champ) {
    if (r.games < c.minGames) continue;
    if (!byRole.has(r.role)) byRole.set(r.role, []);
    byRole.get(r.role).push(r);
  }
  for (const [role, rows] of byRole) {
    const wr = rows.map((r) => wrRole.get(`${r.champion_id}:${role}`));
    const pick = rows.map((r) => r.games / matches);
    const ban = rows.map((r) => ((bans.get(r.champion_id) || 0) / matches) * (r.games / champTotals.get(r.champion_id).games));
    const zw = zScores(wr);
    const zp = zScores(pick.map(Math.sqrt));
    const zb = zScores(ban.map(Math.sqrt));
    rows.forEach((r, i) => {
      const composite = c.weights.winRate * zw[i] + c.weights.pickRate * zp[i] + c.weights.banRate * zb[i];
      const s = round(clamp(50 + c.scoreScale * composite, 0, 100), 1);
      meta.push({
        champion: r.champion_id,
        role,
        score: s,
        tier: c.tiers.find(([, min]) => s >= min)[0],
        win_rate: round((r.wins / r.games) * 100, 2),
        pick_rate: round(pick[i] * 100, 2),
        ban_rate: round(ban[i] * 100, 2),
        games: r.games,
      });
    });
  }

  // Shared by synergy and matchup: deviation from expected
  const deviation = (wins, games, expected) => (wins + c.pairPriorGames * expected) / (games + c.pairPriorGames) - expected;

  const synergy = [];
  for (const r of agg.duo) {
    if (r.games < c.pairMinGames) continue;
    const expected = sigmoid(logit(wrIn(r.champion_id, r.role)) + logit(baseOverall(r.ally_id)));
    const strength = clamp(deviation(r.wins, r.games, expected) / c.synergyFull, -1, 1);
    if (Math.abs(strength) < c.minStrength) continue;
    synergy.push({
      champion: r.champion_id, role: r.role, ally: r.ally_id, strength: round(strength, 3),
      win_rate: round((r.wins / r.games) * 100, 2), games: r.games,
    });
  }

  const matchup = [];
  const lanes = agg.lane.map((r) => ({ ...r, opponent_role: r.role }));
  for (const r of [...lanes, ...(agg.vs || [])]) {
    if (r.games < c.pairMinGames) continue;
    const expected = sigmoid(logit(wrIn(r.champion_id, r.role)) - logit(wrIn(r.opponent_id, r.opponent_role)));
    const strength = clamp(deviation(r.wins, r.games, expected) / c.matchupFull, -1, 1);
    if (Math.abs(strength) < c.minStrength) continue;
    matchup.push({
      champion: r.champion_id, role: r.role, opponent: r.opponent_id, opponent_role: r.opponent_role,
      strength: round(strength, 3), win_rate: round((r.wins / r.games) * 100, 2), games: r.games,
    });
  }

  return { meta, synergy, matchup };
}

module.exports = { score, CONFIG };
