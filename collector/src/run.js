// Runs the collector once: gets data from the source, validates it, writes it to Supabase.
//   npm run collect             -> writes
//   npm run collect:dry         -> checks only, writes nothing
//   node src/run.js --source X  -> use source X instead of COLLECTOR_SOURCE from .env
//   --log <file>                -> also append every line to that file (used by the
//                                  scheduled task, which runs without a window)

const path = require('node:path');
const fs = require('node:fs');
const { createClient } = require('@supabase/supabase-js');
const { toRows } = require('./normalize');
const { writeRows, loadChampions, startRun, finishRun } = require('./writer');

// Fewer meta rows than this means the data is incomplete: keep the current scores
const MIN_META_ROWS = 50;

let logFile = null;
function writeLine(line) {
  console.log(line);
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${line}
`);
  } catch {
    /* a log that can't be written must not stop the collector */
  }
}
const log = (...m) => writeLine([new Date().toISOString(), ...m].join(' '));

function parseArgs(argv) {
  const args = { dryRun: false, source: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--source') args.source = argv[++i];
    else if (argv[i] === '--log') args.log = argv[++i];
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
  // Low priority: games and other programs get the CPU first, even while the model trains
  try {
    const os = require('node:os');
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* not allowed on this system: run at normal priority */
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.log) {
    logFile = path.resolve(args.log);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }
  const env = process.env;

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
  log('ERROR:', err.message || err);
  process.exit(1);
});
