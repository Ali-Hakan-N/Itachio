// A player's own Solo/Duo and Flex games of the season, from Riot. index.js turns them
// into the three kinds of champion statistics (season, this patch, with team-mates) and
// the games of the History tab.
//
// The account id the app reads from the League client is not the one the Riot API uses,
// so the player is looked up by Riot ID (name#tag, linked by the app); their region is
// the one whose match list has their games. Matches go to
// data/players/history-<hash of the account>.jsonl, so each is downloaded once. The season
// is the first number of the patch (16.x); a match of an older season ends the list.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseMatch } = require('../riot/parse');
const { PLATFORMS } = require('../riot/crawl');
const { toCompact, ROLE_INDEX } = require('../model/features');

const DIR = path.join(__dirname, '..', '..', 'data', 'players');
const QUEUES = [440, 420]; // Flex, Solo/Duo
const MAX_GAMES = 500; // per queue, newest first
const PAGE = 100;
// Entries of an older format lack team-mates and the player's numbers: downloaded again
const VERSION = 2;
const ROLE = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'middle', BOTTOM: 'bottom', UTILITY: 'utility' };
const REGIONS = [...new Set(Object.values(PLATFORMS))];

const fileFor = (puuid) => path.join(DIR, `history-${crypto.createHash('sha1').update(puuid).digest('hex').slice(0, 16)}.jsonl`);

function loadCache(puuid) {
  const out = new Map();
  try {
    for (const line of fs.readFileSync(fileFor(puuid), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const g = JSON.parse(line);
        if (g.v === VERSION) out.set(g.id, g);
      } catch {
        /* a line cut off by a crash */
      }
    }
  } catch {
    /* no cache yet */
  }
  return out;
}

/**
 * One player's game from a raw match-v5 response:
 * { v, id, start, patch, q, dur, m, side, role, mates, k, d, a, cs } or { v, id, patch, skip }.
 * mates: Riot accounts (puuid) of the others on the player's side.
 */
function historyGame(raw, puuid) {
  const id = raw?.metadata?.matchId;
  const parsed = parseMatch(raw);
  const m = parsed && toCompact(parsed);
  const parts = raw?.info?.participants || [];
  const me = parts.find((p) => p.puuid === puuid);
  const role = me ? ROLE_INDEX[ROLE[me.teamPosition]] : undefined;
  if (!m || !me || role === undefined) return { v: VERSION, id, patch: parsed?.patch || null, skip: true };
  return {
    v: VERSION,
    id,
    start: parsed.start,
    patch: parsed.patch,
    q: parsed.queue,
    dur: raw.info.gameDuration ?? null,
    m,
    side: me.teamId === 100 ? 'b' : 'r',
    role,
    mates: parts.filter((p) => p.teamId === me.teamId && p.puuid !== puuid).map((p) => p.puuid),
    k: me.kills ?? null,
    d: me.deaths ?? null,
    a: me.assists ?? null,
    cs: (me.totalMinionsKilled ?? 0) + (me.neutralMinionsKilled ?? 0),
  };
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

/** Champion mastery of an account, from the platform server of its region: [{ championId, championPoints, lastPlayTime }] */
async function masteryOf(api, puuid, region) {
  for (const platform of Object.keys(PLATFORMS).filter((p) => PLATFORMS[p] === region)) {
    const list = await api.get(platform, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}`);
    if (list?.length) return list;
  }
  return [];
}

/** "16.21" -> 16 */
const seasonOf = (patch) => Number(String(patch).split('.')[0]);

/**
 * A player's games of the season (new ones fetched): { puuid, games }, or null when the
 * account is not found. patch: the current patch, which names the season.
 */
async function seasonGames(api, riotId, patch, log) {
  const account = await resolveAccount(api, riotId);
  if (!account) {
    log('players: a Riot ID was not found, skipped');
    return null;
  }
  const { puuid, region } = account;
  const season = seasonOf(patch);
  const cache = loadCache(puuid);
  if (region) {
    fs.mkdirSync(DIR, { recursive: true });
    for (const queue of QUEUES) {
      let older = false;
      for (let start = 0; start < MAX_GAMES && !older; start += PAGE) {
        const ids = (await api.get(region, `/lol/match/v5/matches/by-puuid/${puuid}/ids`, { queue, start, count: PAGE })) || [];
        for (const id of ids) {
          let g = cache.get(id);
          if (!g) {
            g = historyGame(await api.get(region, `/lol/match/v5/matches/${id}`), puuid);
            if (!g.id) continue;
            cache.set(g.id, g);
            fs.appendFileSync(fileFor(puuid), `${JSON.stringify(g)}\n`);
          }
          // Newest first: once a match of an older season shows up, the rest are older too
          if (g.patch && seasonOf(g.patch) < season) {
            older = true;
            break;
          }
        }
        if (ids.length < PAGE) break;
      }
    }
  }
  return { puuid, region, games: [...cache.values()].filter((g) => !g.skip && seasonOf(g.patch) === season) };
}

module.exports = { seasonGames, historyGame, resolveAccount, masteryOf };
