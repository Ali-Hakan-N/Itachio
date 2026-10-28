// Turns a source's output into database rows and validates them.
// Pure functions: no network or database access.
//
// A source's collect() output (standard format):
// {
//   patch?: "16.21",
//   meta:    [{ champion, role, score (0-100), tier?, win_rate?, pick_rate?, ban_rate?, games? }],
//   synergy: [{ champion, role, ally,     strength (-1..1), win_rate?, games? }],
//   matchup: [{ champion, role, opponent, opponent_role?, strength (-1..1), win_rate?, games? }]
// opponent_role defaults to role (same lane).
// }
// champion / ally / opponent may be a Riot numeric id, a Data Dragon id ("MonkeyKing")
// or a display name ("Wukong"). Strengths must already account for sample size.

const ROLE_ALIASES = {
  top: 'top',
  jungle: 'jungle', jng: 'jungle', jg: 'jungle',
  middle: 'middle', mid: 'middle',
  bottom: 'bottom', bot: 'bottom', adc: 'bottom', carry: 'bottom',
  utility: 'utility', support: 'utility', sup: 'utility', supp: 'utility',
};

const keyOf = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

function normalizeRole(role) {
  return ROLE_ALIASES[keyOf(role ?? '')] || null;
}

/** Builds a resolver from the champions table: value -> champion id */
function championResolver(champions) {
  const ids = new Set(champions.map((c) => c.id));
  const byKey = new Map();
  const firstWord = new Map(); // "Nunu & Willump" -> "nunu", only if unambiguous
  for (const c of champions) {
    byKey.set(keyOf(c.slug), c.id);
    byKey.set(keyOf(c.name), c.id);
    const w = keyOf(String(c.name).split(/[\s&.']/)[0]);
    firstWord.set(w, firstWord.has(w) ? null : c.id);
  }
  return (value) => {
    if (typeof value === 'number' || /^\d+$/.test(String(value))) {
      const id = Number(value);
      return ids.has(id) ? id : null;
    }
    const k = keyOf(value ?? '');
    return byKey.get(k) ?? firstWord.get(k) ?? null;
  };
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const int = (v) => (num(v) === null ? null : Math.round(Number(v)));
const inRange = (v, lo, hi) => v !== null && v >= lo && v <= hi;

/**
 * @returns {{ meta: object[], synergy: object[], matchup: object[], problems: string[] }}
 */
function toRows(output, champions, { source, collectedAt }) {
  const resolve = championResolver(champions);
  const problems = [];
  const unknown = new Set();
  const seen = { meta: new Set(), synergy: new Set(), matchup: new Set() };
  const base = { source, collected_at: collectedAt };

  const champ = (v) => {
    const id = resolve(v);
    if (id === null) unknown.add(String(v));
    return id;
  };
  // If the same key appears twice, the first one wins
  const once = (table, key) => {
    if (seen[table].has(key)) return false;
    seen[table].add(key);
    return true;
  };

  const meta = [];
  for (const r of output.meta || []) {
    const champion_id = champ(r.champion);
    const role = normalizeRole(r.role);
    const score = num(r.score);
    if (champion_id === null) continue;
    if (!role) { problems.push(`meta: unknown role "${r.role}"`); continue; }
    if (!inRange(score, 0, 100)) { problems.push(`meta: ${r.champion}/${role} score outside 0-100 (${r.score})`); continue; }
    if (!once('meta', `${champion_id}:${role}`)) continue;
    meta.push({
      ...base, champion_id, role, patch: output.patch ?? null, score,
      tier: r.tier ?? null, win_rate: num(r.win_rate), pick_rate: num(r.pick_rate),
      ban_rate: num(r.ban_rate), games: int(r.games),
    });
  }

  const synergy = [];
  for (const r of output.synergy || []) {
    const champion_id = champ(r.champion);
    const ally_id = champ(r.ally);
    const role = normalizeRole(r.role);
    const strength = num(r.strength);
    if (champion_id === null || ally_id === null || champion_id === ally_id) continue;
    if (!role) { problems.push(`synergy: unknown role "${r.role}"`); continue; }
    if (!inRange(strength, -1, 1)) { problems.push(`synergy: ${r.champion}+${r.ally} strength outside -1..1 (${r.strength})`); continue; }
    if (!once('synergy', `${champion_id}:${role}:${ally_id}`)) continue;
    synergy.push({ ...base, champion_id, role, ally_id, strength, win_rate: num(r.win_rate), games: int(r.games) });
  }

  const matchup = [];
  for (const r of output.matchup || []) {
    const champion_id = champ(r.champion);
    const opponent_id = champ(r.opponent);
    const role = normalizeRole(r.role);
    const opponent_role = r.opponent_role === undefined || r.opponent_role === null ? role : normalizeRole(r.opponent_role);
    const strength = num(r.strength);
    if (champion_id === null || opponent_id === null || champion_id === opponent_id) continue;
    if (!opponent_role) { problems.push(`matchup: unknown opponent role "${r.opponent_role}"`); continue; }
    if (!role) { problems.push(`matchup: unknown role "${r.role}"`); continue; }
    if (!inRange(strength, -1, 1)) { problems.push(`matchup: ${r.champion}-${r.opponent} strength outside -1..1 (${r.strength})`); continue; }
    if (!once('matchup', `${champion_id}:${role}:${opponent_id}:${opponent_role}`)) continue;
    matchup.push({ ...base, champion_id, role, opponent_id, opponent_role, strength, win_rate: num(r.win_rate), games: int(r.games) });
  }

  if (unknown.size) problems.unshift(`unknown champions: ${[...unknown].slice(0, 15).join(', ')}${unknown.size > 15 ? ' …' : ''}`);
  return { meta, synergy, matchup, problems };
}

module.exports = { toRows, normalizeRole, championResolver };
