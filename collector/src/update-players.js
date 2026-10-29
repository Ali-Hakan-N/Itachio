// Updates the player analysis once, right away:   npm run players
// The collector also does it on its own after a training, every few hours.

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { RiotClient } = require('./riot/client');
const { updatePlayers } = require('./players');

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
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const api = new RiotClient({ key: env.RIOT_API_KEY, limits: env.RIOT_RATE_LIMITS || undefined, log });
  await updatePlayers({ client, api, log });
}

main().catch((err) => {
  log('ERROR:', err.message || err);
  process.exit(1);
});
