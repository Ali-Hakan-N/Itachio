// Backtest of the personal layer on the team's stored games:   npm run players:backtest
// Reads only: the newest model snapshot, player_games and the mastery of
// player_champion_stats. See players/backtest.js for what is measured.

const { createClient } = require('@supabase/supabase-js');
const { backtestPersonal, gamesFromRows, defaultVariants } = require('./players/backtest');

const PAGE = 1000;

async function readAll(client, table, columns, filter = (q) => q) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await filter(client.from(table).select(columns)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) return out;
  }
}

async function main() {
  const env = process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const snap = await client.from('model_snapshots').select('data').order('id', { ascending: false }).limit(1).maybeSingle();
  if (snap.error) throw new Error(snap.error.message);
  if (!snap.data) throw new Error('No model snapshot yet');
  const rows = await readAll(client, 'player_games', 'player_id,match_id,started_at,patch,side,role,champion_id,win,blue,red,lineup');
  const masteryRows = await readAll(client, 'player_champion_stats', 'player_id,champion_id,mastery', (q) => q.eq('source', 'season').gt('mastery', 0))
    .catch(() => []);
  const mastery = new Map();
  for (const r of masteryRows) {
    if (!mastery.has(r.player_id)) mastery.set(r.player_id, new Map());
    mastery.get(r.player_id).set(r.champion_id, Number(r.mastery));
  }

  const byPlayer = gamesFromRows(rows);
  const { folds, games, results } = backtestPersonal({ data: snap.data.data ?? snap.data, byPlayer, variants: defaultVariants(), mastery });
  console.log(`${byPlayer.size} players, ${games} games, ${folds} time folds (each predicted from the games before it)`);
  if (!folds) return console.log('Not enough games for a backtest yet');
  const none = results[0];
  const pad = Math.max(...results.map((r) => r.name.length));
  console.log(`${'variant'.padEnd(pad)}  games   log loss   Δ vs none (×1000) ± SE   Brier    mean |delta|`);
  for (const r of results) {
    const diff = (r.logLoss - none.logLoss) * 1000;
    console.log(`${r.name.padEnd(pad)}  ${String(r.n).padStart(5)}   ${r.logLoss.toFixed(5)}   ${((diff >= 0 ? '+' : '') + diff.toFixed(2)).padStart(7)} ± ${(r.seVsFirst * 1000).toFixed(2).padEnd(5)}          ${r.brier.toFixed(5)}  ${r.meanAbsDelta.toFixed(4)}`);
  }
  const best = results.slice(1).reduce((a, b) => (b.logLoss < a.logLoss ? b : a));
  console.log(`Best: ${best.name} (${((best.logLoss - none.logLoss) * 1000).toFixed(2)} ×1000 vs the draft alone)`);
}

main().catch((err) => {
  console.error('ERROR:', err.message || err);
  process.exit(1);
});
