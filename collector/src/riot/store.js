// Database access for the Riot collector (runs with service_role).

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

/** Current patch from app_meta ("16.21.1") -> "16.21" */
async function currentPatch(client) {
  const row = check(await client.from('app_meta').select('value').eq('key', 'current_patch').maybeSingle());
  const m = /^(\d+)\.(\d+)/.exec(row?.value || '');
  if (!m) throw new Error('app_meta.current_patch is missing; run sync-ddragon first');
  return `${m[1]}.${m[2]}`;
}

/** Returns the match ids that have not been processed yet */
async function filterUnseen(client, ids) {
  const seen = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const rows = check(await client.from('riot_matches').select('match_id').in('match_id', ids.slice(i, i + 200)));
    for (const r of rows) seen.add(r.match_id);
  }
  return ids.filter((id) => !seen.has(id));
}

/** Adds matches and bumps the counters; returns the number of newly added matches */
async function ingest(client, matches) {
  if (!matches.length) return 0;
  return check(await client.rpc('riot_ingest', { p_matches: matches }));
}

// Supabase returns at most 1000 rows per request; pages are ordered by the full primary key
async function fetchAll(client, table, columns, patch, order) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = client.from(table).select(columns).eq('patch', patch);
    for (const col of order) q = q.order(col);
    const page = check(await q.range(from, from + 999));
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function loadAggregates(client, patch) {
  const total = check(await client.from('riot_patch_totals').select('matches').eq('patch', patch).maybeSingle());
  const [champ, bans, duo, lane, vs] = await Promise.all([
    fetchAll(client, 'riot_champ_stats', 'champion_id,role,games,wins', patch, ['champion_id', 'role']),
    fetchAll(client, 'riot_ban_stats', 'champion_id,bans', patch, ['champion_id']),
    fetchAll(client, 'riot_duo_stats', 'champion_id,role,ally_id,games,wins', patch, ['champion_id', 'role', 'ally_id']),
    fetchAll(client, 'riot_lane_stats', 'champion_id,role,opponent_id,games,wins', patch, ['champion_id', 'role', 'opponent_id']),
    fetchAll(client, 'riot_vs_stats', 'champion_id,role,opponent_id,opponent_role,games,wins', patch,
      ['champion_id', 'role', 'opponent_id', 'opponent_role']),
  ]);
  return { matches: total?.matches || 0, champ, bans, duo, lane, vs };
}

module.exports = { currentPatch, filterUnseen, ingest, loadAggregates };
