// Player analysis, two kinds, each written to player_champion_stats with its source:
//   history  every Solo/Duo and Flex game of the player in the current patch, from Riot
//            (history.js, by Riot ID)
//   team     the Flex games all five team members played together, recorded by the app
//            (drafts with queue 440 and every ally pick linked to a team member), read
//            once from Riot by match id (server + game id) into data/players/team-games.jsonl.
//            Players are matched by their pick in the recorded draft. Every such game
//            counts, always.
// How each player does on each champion comes from analyze.js for both.

const fs = require('node:fs');
const path = require('node:path');
const { parseMatch } = require('../riot/parse');
const { PLATFORMS } = require('../riot/crawl');
const { toCompact } = require('../model/features');
const { analyzePlayers } = require('./analyze');
const { RiotKeyError } = require('../riot/client');
const { currentPatch } = require('../riot/store');
const { patchGames } = require('./history');

// Set to false to pause the analysis (the app reads player_champion_stats with PLAYER_STATS)
const ENABLED = true;
const FLEX = 440;
const TEAM_SIZE = 5;

const DIR = path.join(__dirname, '..', '..', 'data', 'players');
const CACHE = path.join(DIR, 'team-games.jsonl');

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

function loadCache() {
  const out = new Map();
  try {
    for (const line of fs.readFileSync(CACHE, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const g = JSON.parse(line);
        out.set(g.id, g);
      } catch {
        /* a line cut off by a crash */
      }
    }
  } catch {
    /* no cache yet */
  }
  return out;
}

/** A team game from a raw match-v5 response: { id, start, m } or { id, skip } */
function teamGame(raw, id) {
  const parsed = parseMatch(raw);
  const m = parsed && toCompact(parsed);
  return m ? { id, start: parsed.start, m } : { id, skip: true };
}

async function selectAll(query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = check(await query().range(from, from + 999));
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

/**
 * The qualifying games: [{ matchId, region, draft, picks: [{ playerId, championId }] }],
 * drafts of finished Flex games with all five ally picks made by team members.
 */
async function teamDrafts(client, players) {
  const team = new Map(players.map((p) => [p.id, p.team_id]));
  const drafts = await selectAll(() =>
    client.from('drafts').select('id,team_id,lcu_game_id,platform,our_side,started_at')
      .eq('queue_id', FLEX).eq('status', 'finished').not('platform', 'is', null).not('lcu_game_id', 'is', null).order('id'),
  );
  if (!drafts.length) return [];
  const actions = [];
  for (let i = 0; i < drafts.length; i += 200) {
    const ids = drafts.slice(i, i + 200).map((d) => d.id);
    actions.push(...(await selectAll(() =>
      client.from('draft_actions').select('id,draft_id,player_id,champion_id').in('draft_id', ids).eq('side', 'ally').eq('kind', 'pick').order('id'),
    )));
  }
  const byDraft = new Map();
  for (const a of actions) {
    if (!byDraft.has(a.draft_id)) byDraft.set(a.draft_id, []);
    byDraft.get(a.draft_id).push(a);
  }
  const out = [];
  for (const d of drafts) {
    const picks = byDraft.get(d.id) || [];
    const own = picks.filter((p) => p.player_id && team.get(p.player_id) === d.team_id);
    if (own.length !== TEAM_SIZE || new Set(own.map((p) => p.player_id)).size !== TEAM_SIZE) continue;
    const region = PLATFORMS[String(d.platform).toLowerCase()];
    if (!region) continue;
    out.push({
      matchId: `${String(d.platform).toUpperCase()}_${d.lcu_game_id}`,
      region,
      draft: d,
      picks: own.map((p) => ({ playerId: p.player_id, championId: p.champion_id })),
    });
  }
  return out;
}

/** Replaces the rows of one source for these players */
async function writeStats(client, source, byPlayer, model, log) {
  const { rows, nE, familiarity } = analyzePlayers(model, byPlayer);
  const ids = [...byPlayer.keys()];
  check(await client.from('player_champion_stats').delete().in('player_id', ids).eq('source', source));
  const stamp = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 500) {
    check(await client.from('player_champion_stats').insert(rows.slice(i, i + 500).map((r) => ({ ...r, source, updated_at: stamp }))));
  }
  const count = [...byPlayer.values()].reduce((a, g) => a + g.length, 0);
  log(`players: ${source}: ${byPlayer.size} players, ${count} games, ${rows.length} champion rows · early shrinkage ${nE.toFixed(1)} games · unplayed champions ${familiarity >= 0 ? '+' : ''}${familiarity.toFixed(3)} log-odds`);
}

/** History: every team member's Solo/Duo and Flex games of the current patch */
async function updateHistory({ client, api, log, model, players }) {
  const patch = await currentPatch(client);
  const byPlayer = new Map();
  for (const p of players.filter((x) => x.riot_id)) {
    try {
      const games = await patchGames(api, p.riot_id, patch, log);
      if (games.length) byPlayer.set(p.id, games);
    } catch (err) {
      if (err instanceof RiotKeyError) throw err;
      log(`players: could not load a player's matches (${err.message}), skipped`);
    }
  }
  if (!byPlayer.size) return log(`players: history: no games of patch ${patch} yet`);
  await writeStats(client, 'history', byPlayer, model, log);
}

/**
 * Updates player_champion_stats for every team member: their own games of the patch
 * (history) and the team's full Flex games (team).
 * data: the exported model to compare against (newest snapshot when not given).
 */
async function updatePlayers({ client, api, log, data = null }) {
  if (!ENABLED) return log('players: analysis is paused');
  const model = data || check(await client.from('model_snapshots').select('data').order('id', { ascending: false }).limit(1).maybeSingle())?.data;
  if (!model) return log('players: no model yet, skipped');
  const players = check(await client.from('players').select('id,team_id,riot_id').not('team_id', 'is', null));
  await updateHistory({ client, api, log, model, players });
  await updateTeam({ client, api, log, model, players });
}

/** Team: the Flex games the whole team played together */
async function updateTeam({ client, api, log, model, players }) {
  const games = await teamDrafts(client, players);
  if (!games.length) return log('players: team: no Flex games of a full team recorded yet');

  // New games from Riot
  const cache = loadCache();
  let fetched = 0;
  for (const g of games) {
    if (cache.has(g.matchId)) continue;
    try {
      const raw = await api.get(g.region, `/lol/match/v5/matches/${g.matchId}`);
      if (!raw) continue; // not found yet: Riot publishes a match a little after it ends
      const entry = teamGame(raw, g.matchId);
      fs.mkdirSync(DIR, { recursive: true });
      fs.appendFileSync(CACHE, `${JSON.stringify(entry)}\n`);
      cache.set(g.matchId, entry);
      fetched++;
    } catch (err) {
      if (err instanceof RiotKeyError) throw err;
      log(`players: could not load a team game (${err.message}), skipped`);
    }
  }

  // Every player's games: their role is where their champion sits on our side
  const byPlayer = new Map();
  for (const g of games) {
    const entry = cache.get(g.matchId);
    if (!entry || entry.skip) continue;
    const side = g.draft.our_side === 'red' ? 'r' : 'b';
    const team = side === 'b' ? entry.m.b : entry.m.r;
    for (const p of g.picks) {
      const role = team.indexOf(p.championId);
      if (role < 0) continue;
      if (!byPlayer.has(p.playerId)) byPlayer.set(p.playerId, []);
      byPlayer.get(p.playerId).push({ id: g.matchId, start: entry.start, m: entry.m, side, role });
    }
  }
  if (!byPlayer.size) return log(`players: team: ${games.length} games, none usable yet`);
  log(`players: team: ${games.length} full-team Flex games (${fetched} new)`);
  await writeStats(client, 'team', byPlayer, model, log);
}

module.exports = { updatePlayers, teamGame, teamDrafts };
