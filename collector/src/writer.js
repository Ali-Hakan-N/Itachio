// Writes rows to Supabase. Each table of a source is rewritten as a whole:
// new rows are upserted first, then the source's rows that did not come in
// this run are deleted. If a source returned no rows for a table, that table
// is left alone (a half-finished run must not wipe good data).

const TABLES = {
  meta: { name: 'champion_meta', conflict: 'champion_id,role,source' },
  synergy: { name: 'champion_synergy', conflict: 'champion_id,role,ally_id,source' },
  matchup: { name: 'champion_matchup', conflict: 'champion_id,role,opponent_id,opponent_role,source' },
};
const CHUNK = 500;
const { championResolver, normalizeRole } = require('./normalize');

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

async function writeRows(client, rows, { source, collectedAt }) {
  const stats = {};
  for (const [kind, t] of Object.entries(TABLES)) {
    const list = rows[kind];
    if (!list.length) {
      stats[kind] = { written: 0, removed: 0, skipped: true };
      continue;
    }
    for (let i = 0; i < list.length; i += CHUNK) {
      check(await client.from(t.name).upsert(list.slice(i, i + CHUNK), { onConflict: t.conflict }));
    }
    const removed = check(
      await client.from(t.name).delete().eq('source', source).lt('collected_at', collectedAt).select('champion_id'),
    );
    stats[kind] = { written: list.length, removed: removed.length };
  }
  return stats;
}

async function writeMetaSourceSnapshot(client, { patch, collectedAt, rows }) {
  if (!patch || !rows.meta.length) return false;
  const cutoff = new Date(Date.parse(collectedAt) - 120 * 86400000).toISOString();
  const project = (list, fields) => list.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
  const data = {
    meta: project(rows.meta, ['champion_id', 'role', 'score']),
    synergy: project(rows.synergy, ['champion_id', 'role', 'ally_id', 'strength']),
    matchup: project(rows.matchup, ['champion_id', 'role', 'opponent_id', 'opponent_role', 'strength']),
  };
  check(await client.from('meta_source_snapshots').insert({ source: 'metasrc', patch, collected_at: collectedAt, data }));
  check(await client.from('meta_source_snapshots').delete().lt('collected_at', cutoff));
  return true;
}

/**
 * MetaSRC's builds (sources/metasrc-builds.js) to app_meta 'metasrc_builds', keyed
 * "champion id:role"; model/builds.js blends them into the builds the app reads.
 * Returns how many champion roles were stored.
 */
async function writeMetaBuilds(client, { builds, patch, collectedAt }, champions) {
  const resolve = championResolver(champions);
  const out = {};
  for (const { champion, role, ...entry } of builds || []) {
    const id = resolve(champion);
    if (id !== null && normalizeRole(role)) out[`${id}:${normalizeRole(role)}`] = entry;
  }
  const n = Object.keys(out).length;
  if (!n) return 0;
  check(await client.from('app_meta').upsert({ key: 'metasrc_builds', value: JSON.stringify({ patch, collectedAt, builds: out }), updated_at: collectedAt }));
  return n;
}

async function loadChampions(client) {
  return check(await client.from('champions').select('id,slug,name'));
}

async function startRun(client, source) {
  return check(await client.from('collector_runs').insert({ source }).select('id').single()).id;
}

async function finishRun(client, id, fields) {
  check(await client.from('collector_runs').update({ ...fields, finished_at: new Date().toISOString() }).eq('id', id));
}

module.exports = { writeRows, writeMetaSourceSnapshot, writeMetaBuilds, loadChampions, startRun, finishRun };
