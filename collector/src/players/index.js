// Player analysis: fetches the Flex and Solo/Duo matches of every player in a team (their
// Riot account is linked by the app), keeps them on this computer, and writes how each
// player does on each champion (analyze.js) to player_champion_stats.
//
// The account id the app reads from the League client is not the one the Riot API
// uses, so the player is looked up by Riot ID (name#tag, also linked by the app). Their
// server is the region whose match list has their games. Matches go to
// data/players/<hash of the account>.jsonl, so each match is downloaded once; later runs
// only fetch what is new. Up to MAX_GAMES of each player's newest games from the last
// LOOKBACK_DAYS are used.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseMatch } = require('../riot/parse');
const { PLATFORMS } = require('../riot/crawl');
const { toCompact, ROLE_INDEX } = require('../model/features');
const { analyzePlayers } = require('./analyze');
const { RiotKeyError } = require('../riot/client');

// Paused for now: no player matches are fetched and no stats are written. Set to true to
// turn the analysis back on (the app reads player_champion_stats again with PLAYER_STATS).
const ENABLED = false;

const DIR = path.join(__dirname, '..', '..', 'data', 'players');
const QUEUES = [440, 420]; // Flex, Solo/Duo
const MAX_GAMES = 300;
const LOOKBACK_DAYS = 365;
const PAGE = 100;
const ROLE = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'middle', BOTTOM: 'bottom', UTILITY: 'utility' };
const REGIONS = [...new Set(Object.values(PLATFORMS))];

const fileFor = (puuid) => path.join(DIR, `${crypto.createHash('sha1').update(puuid).digest('hex').slice(0, 16)}.jsonl`);

function loadCache(puuid) {
  const out = new Map();
  try {
    for (const line of fs.readFileSync(fileFor(puuid), 'utf8').split('\n')) {
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

/** One player's game from a raw match-v5 response, or { id, skip } when it does not count */
function playerGame(raw, puuid) {
  const id = raw?.metadata?.matchId;
  const parsed = parseMatch(raw);
  const m = parsed && toCompact(parsed);
  const me = raw?.info?.participants?.find((p) => p.puuid === puuid);
  const role = me ? ROLE_INDEX[ROLE[me.teamPosition]] : undefined;
  if (!m || !me || role === undefined) return { id, skip: true };
  return { id, start: parsed.start, q: parsed.queue, m, side: me.teamId === 100 ? 'b' : 'r', role };
}

/** The Riot API account (puuid) of a Riot ID "name#tag", and the region with their matches */
async function resolveAccount(api, riotId) {
  const [name, tag] = String(riotId || '').split('#');
  if (!name || !tag) return null;
  const account = await api.get('europe', `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  if (!account?.puuid) return null;
  for (const region of REGIONS) {
    const ids = await api.get(region, `/lol/match/v5/matches/by-puuid/${account.puuid}/ids`, { count: 1 });
    if (ids?.length) return { puuid: account.puuid, region };
  }
  return { puuid: account.puuid, region: null };
}

/** Fetches new matches of one player into the cache; returns their games, newest MAX_GAMES */
async function syncPlayer(api, riotId, log) {
  const account = await resolveAccount(api, riotId);
  if (!account) {
    log('players: a Riot ID was not found, skipped');
    return [];
  }
  const { puuid, region } = account;
  const cache = loadCache(puuid);
  if (!region) return [...cache.values()].filter((g) => !g.skip);
  const since = Math.floor((Date.now() - LOOKBACK_DAYS * 86_400_000) / 1000);
  const ids = [];
  for (const queue of QUEUES) {
    for (let start = 0; start < MAX_GAMES; start += PAGE) {
      const page = (await api.get(region, `/lol/match/v5/matches/by-puuid/${puuid}/ids`, { queue, start, count: PAGE, startTime: since })) || [];
      ids.push(...page);
      if (page.length < PAGE) break;
    }
  }
  const fresh = ids.filter((id) => !cache.has(id));
  if (fresh.length) {
    fs.mkdirSync(DIR, { recursive: true });
    for (const id of fresh) {
      const g = playerGame(await api.get(region, `/lol/match/v5/matches/${id}`), puuid);
      if (!g.id) continue;
      cache.set(g.id, g);
      fs.appendFileSync(fileFor(puuid), `${JSON.stringify(g)}\n`);
    }
  }
  return [...cache.values()].filter((g) => !g.skip).sort((a, b) => b.start - a.start).slice(0, MAX_GAMES);
}

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Updates player_champion_stats for every player with a linked account.
 * data: the exported model to compare against (newest snapshot when not given).
 */
async function updatePlayers({ client, api, log, data = null }) {
  if (!ENABLED) return log('players: analysis is paused');
  const model = data || check(await client.from('model_snapshots').select('data').order('id', { ascending: false }).limit(1).maybeSingle())?.data;
  if (!model) return log('players: no model yet, skipped');
  const players = check(await client.from('players').select('id,riot_id').not('riot_id', 'is', null).not('team_id', 'is', null));
  if (!players.length) return log('players: no linked accounts');

  const byPlayer = new Map();
  for (const p of players) {
    try {
      const games = await syncPlayer(api, p.riot_id, log);
      if (games.length) byPlayer.set(p.id, games);
    } catch (err) {
      if (err instanceof RiotKeyError) throw err;
      log(`players: could not load a player's matches (${err.message}), skipped`);
    }
  }
  if (!byPlayer.size) return log('players: no matches found');

  const { rows, nE, familiarity } = analyzePlayers(model, byPlayer);
  const ids = [...byPlayer.keys()];
  check(await client.from('player_champion_stats').delete().in('player_id', ids));
  const stamp = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 500) {
    check(await client.from('player_champion_stats').insert(rows.slice(i, i + 500).map((r) => ({ ...r, updated_at: stamp }))));
  }
  const games = [...byPlayer.values()].reduce((a, g) => a + g.length, 0);
  log(`players: ${byPlayer.size} players, ${games} games, ${rows.length} champion rows · early shrinkage ${nE.toFixed(1)} games · unplayed champions ${familiarity >= 0 ? '+' : ''}${familiarity.toFixed(3)} log-odds`);
}

module.exports = { updatePlayers, playerGame };
