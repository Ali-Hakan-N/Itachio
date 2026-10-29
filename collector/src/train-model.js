// Trains the win model once on the stored matches and uploads it, right away.
//   npm run train            -> trains now, even if a game is running
//   npm run train -- --wait  -> waits (up to 3 hours) until no game is running
// The collector also trains on its own about once an hour; this is for a manual run.

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const model = require('./model');
const { currentPatch } = require('./riot/store');

const LOG_FILE = path.join(__dirname, '..', 'logs', 'collect.log');

const log = (...m) => {
  const line = [new Date().toISOString(), ...m].join(' ');
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    /* the log is optional */
  }
};

async function main() {
  const env = process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  }
  const wait = process.argv.includes('--wait');
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const patch = await currentPatch(client);
  log(`manual training for patch ${patch}${wait ? ' (waits for a free computer)' : ''}`);
  const metrics = await model.trainAndPublish({
    client,
    patch,
    log,
    waitMs: wait ? 3 * 60 * 60_000 : 0,
    ignoreBusy: !wait,
  });
  if (!metrics) log('no model uploaded');
}

main().catch((err) => {
  log('ERROR:', err.message || err);
  process.exit(1);
});
