// Player analysis. Every team member's ranked games (Solo/Duo and Flex) of the season are
// read from Riot (history.js, by Riot ID) and give three kinds of champion statistics,
// each written to player_champion_stats with its source:
//   season   all of them: how well the player plays each champion
//   history  those of the current patch: the same with less data, and how the champion
//            does for them in this patch
//   team     those where all five on the player's side were team members (no one from
//            outside), per line-up (the sorted ids of the five): how the player does on a
//            champion with exactly this team
// All three are inputs of the player's scores, and each counts as much as its games back
// it: analyze.js shrinks every champion hard toward the player's own level, so one bad
// game moves little.
// How each player does on each champion comes from analyze.js for all three. The games
// also go to player_games, for the History tab.

const { analyzePlayers } = require('./analyze');
const { RiotKeyError } = require('../riot/client');
const { currentPatch } = require('../riot/store');
const { seasonGames } = require('./history');

// Set to false to pause the analysis (the app reads player_champion_stats with PLAYER_STATS)
const ENABLED = true;
const ROLES = ['top', 'jungle', 'middle', 'bottom', 'utility'];

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Line-up of a game: the team members on the player's side (the player included), as
 * their sorted ids joined by commas, or '' when the player was the only one.
 * teamOf: Map Riot account -> player id, of the player's team.
 */
function lineupOf(playerId, game, teamOf) {
  const ids = (game.mates || []).map((p) => teamOf.get(p)).filter((id) => id && id !== playerId);
  return ids.length ? [playerId, ...new Set(ids)].sort().join(',') : '';
}

const TEAM_SIZE = 5;

/**
 * Splits every player's full-team games by line-up: Map "<player>|<lineup>" -> games.
 * Only games where all five on the player's side were team members count.
 */
function byLineup(byPlayer, lineups) {
  const out = new Map();
  for (const [id, games] of byPlayer) {
    for (const g of games) {
      const lineup = lineups.get(id)?.get(g.id);
      if (!lineup || lineup.split(',').length !== TEAM_SIZE) continue;
      const key = `${id}|${lineup}`;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(g);
    }
  }
  return out;
}

/** Replaces the rows of one source for these players; a key is a player id, or "<player>|<lineup>" */
async function writeStats(client, source, byKey, model, log, playerIds) {
  const { rows, nE, familiarity } = analyzePlayers(model, byKey);
  check(await client.from('player_champion_stats').delete().in('player_id', playerIds).eq('source', source));
  const stamp = new Date().toISOString();
  const out = rows.map(({ player_id: key, ...r }) => {
    const [player, lineup = ''] = key.split('|');
    return { ...r, player_id: player, lineup, source, updated_at: stamp };
  });
  for (let i = 0; i < out.length; i += 500) {
    check(await client.from('player_champion_stats').insert(out.slice(i, i + 500)));
  }
  const count = [...byKey.values()].reduce((a, g) => a + g.length, 0);
  log(`players: ${source}: ${byKey.size} ${source === 'team' ? 'line-ups' : 'players'}, ${count} games, ${out.length} champion rows · early shrinkage ${nE.toFixed(1)} games · unplayed champions ${familiarity >= 0 ? '+' : ''}${familiarity.toFixed(3)} log-odds`);
}

/** A game as a player_games row */
function gameRow(playerId, g, lineup) {
  const blue = g.side === 'b';
  const win = blue ? g.m.w === 1 : g.m.w === 0;
  return {
    player_id: playerId,
    match_id: g.id,
    started_at: new Date(g.start).toISOString(),
    queue_id: g.q,
    patch: g.patch,
    duration_s: g.dur,
    side: blue ? 'blue' : 'red',
    role: ROLES[g.role],
    champion_id: (blue ? g.m.b : g.m.r)[g.role],
    win,
    kills: g.k,
    deaths: g.d,
    assists: g.a,
    cs: g.cs,
    blue: g.m.b,
    red: g.m.r,
    lineup,
  };
}

async function writeGames(client, byPlayer, lineups) {
  const rows = [];
  for (const [id, games] of byPlayer) for (const g of games) rows.push(gameRow(id, g, lineups.get(id)?.get(g.id) || ''));
  for (let i = 0; i < rows.length; i += 500) {
    check(await client.from('player_games').upsert(rows.slice(i, i + 500), { onConflict: 'player_id,match_id' }));
  }
}

/**
 * Updates player_champion_stats and player_games for every team member.
 * data: the exported model to compare against (newest snapshot when not given).
 */
async function updatePlayers({ client, api, log, data = null }) {
  if (!ENABLED) return log('players: analysis is paused');
  const model = data || check(await client.from('model_snapshots').select('data').order('id', { ascending: false }).limit(1).maybeSingle())?.data;
  if (!model) return log('players: no model yet, skipped');
  const players = check(await client.from('players').select('id,team_id,riot_id').not('team_id', 'is', null));
  const patch = await currentPatch(client);

  const byPlayer = new Map();
  const account = new Map(); // player id -> Riot account
  for (const p of players.filter((x) => x.riot_id)) {
    try {
      const res = await seasonGames(api, p.riot_id, patch, log);
      if (!res) continue;
      account.set(p.id, res.puuid);
      if (res.games.length) byPlayer.set(p.id, res.games);
    } catch (err) {
      if (err instanceof RiotKeyError) throw err;
      log(`players: could not load a player's matches (${err.message}), skipped`);
    }
  }
  if (!byPlayer.size) return log('players: no ranked games of the season yet');

  // Line-up of every game: team-mates are found by their Riot account
  const lineups = new Map();
  for (const [id, games] of byPlayer) {
    const team = players.find((p) => p.id === id).team_id;
    const teamOf = new Map(players.filter((p) => p.team_id === team && account.has(p.id)).map((p) => [account.get(p.id), p.id]));
    lineups.set(id, new Map(games.map((g) => [g.id, lineupOf(id, g, teamOf)])));
  }

  const ids = [...byPlayer.keys()];
  const patchGames = new Map([...byPlayer].map(([id, games]) => [id, games.filter((g) => g.patch === patch)]).filter(([, g]) => g.length));
  await writeStats(client, 'season', byPlayer, model, log, ids);
  if (patchGames.size) await writeStats(client, 'history', patchGames, model, log, ids);
  else log(`players: history: no games of patch ${patch} yet`);
  const team = byLineup(byPlayer, lineups);
  if (team.size) await writeStats(client, 'team', team, model, log, ids);
  else log('players: team: no games of five team members together yet');
  await writeGames(client, byPlayer, lineups);
}

module.exports = { updatePlayers, lineupOf, byLineup, gameRow };
