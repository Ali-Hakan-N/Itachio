// Runs the collector once: gets data from the source, validates it, writes it to Supabase.
//   npm run collect             -> writes
//   npm run collect:dry         -> checks only, writes nothing
//   node src/run.js --source X  -> use source X instead of COLLECTOR_SOURCE from .env

const path = require('node:path');
const fs = require('node:fs');
const { createClient } = require('@supabase/supabase-js');
const { toRows } = require('./normalize');
const { writeRows, loadChampions, startRun, finishRun } = require('./writer');

// Fewer meta rows than this means the data is incomplete: keep the current scores
const MIN_META_ROWS = 50;

function parseArgs(argv) {
  const args = { dryRun: false, source: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--source') args.source = argv[++i];
  }
  return args;
}

function loadSource(name) {
  if (!/^[a-z0-9-]+$/.test(name || '')) throw new Error(`invalid source name: ${name}`);
  const file = path.join(__dirname, 'sources', `${name}.js`);
  if (!fs.existsSync(file)) throw new Error(`source not found: src/sources/${name}.js`);
  return require(file);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const log = (...m) => console.log(new Date().toISOString(), ...m);

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  }
  const source = loadSource(args.source || env.COLLECTOR_SOURCE);
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const runId = args.dryRun ? null : await startRun(client, source.name);
  try {
    const champions = await loadChampions(client);
    if (!champions.length) throw new Error('champions table is empty; run sync-ddragon first');

    // Validates a source output and replaces the scores with it. Sources may call it
    // during a long run too, so the app gets fresh scores without waiting for the end.
    const publish = async (output) => {
      const collectedAt = new Date().toISOString();
      const rows = toRows(output, champions, { source: source.name, collectedAt });
      for (const p of rows.problems.slice(0, 20)) log('warning:', p);
      log(`meta ${rows.meta.length} · synergy ${rows.synergy.length} · matchup ${rows.matchup.length}`);
      if (args.dryRun) return { written: false, note: 'dry run' };
      if (rows.meta.length < MIN_META_ROWS) {
        // Not an error, e.g. the first day of a new patch. Current scores stay in place.
        const note = `only ${rows.meta.length} meta rows (need ${MIN_META_ROWS}); scores not updated`;
        log(note);
        return { written: false, note };
      }
      const stats = await writeRows(client, rows, { source: source.name, collectedAt });
      log('scores updated', JSON.stringify(stats));
      return { written: true, ...stats, problems: rows.problems.length };
    };

    log(`source: ${source.name}`);
    const output = await source.collect({ env, log, client, dryRun: args.dryRun, publish });
    const result = await publish(output);
    if (args.dryRun) {
      log('dry run: nothing written');
      return;
    }
    await finishRun(client, runId, { status: 'ok', stats: { ...result, source: output.stats || null } });
    log('done');
  } catch (err) {
    if (runId) await finishRun(client, runId, { status: 'error', error: String(err.message || err) }).catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error(new Date().toISOString(), 'ERROR:', err.message || err);
  process.exit(1);
});
