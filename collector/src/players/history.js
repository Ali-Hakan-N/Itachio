// A player's own Solo/Duo and Flex games of the current patch, from Riot. Used for the
// "history" champion statistics (index.js); the "team" statistics come from the team's
// recorded games instead.
//
// The account id the app reads from the League client is not the one the Riot API uses,
// so the player is looked up by Riot ID (name#tag, linked by the app); their region is
// the one whose match list has their games. Matches go to
// data/players/history-<hash of the account>.jsonl, so each is downloaded once; matches
// of older patches are remembered as such and not downloaded again.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseMatch } = require('../riot/parse');
const { PLATFORMS } = require('../riot/crawl');
const { toCompact, ROLE_INDEX } = require('../model/features');

const DIR = path.join(__dirname, '..', '..', 'data', 'players');
const QUEUES = [440, 420]; // Flex, Solo/Duo
const MAX_GAMES = 300; // per queue, newest first
const LOOKBACK_DAYS = 28; // a patch is shorter; older matches are of older patches
const PAGE = 100;
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

/** One player's game from a raw match-v5 response: { id, start, patch, m, side, role } or { id, patch, skip } */
function historyGame(raw, puuid) {
  const id = raw?.metadata?.matchId;
  const parsed = parseMatch(raw);
  const m = parsed && toCompact(parsed);
  const me = raw?.info?.participants?.find((p) => p.puuid === puuid);
  const role = me ? ROLE_INDEX[ROLE[me.teamPosition]] : undefined;
  if (!m || !me || role === undefined) return { id, patch: parsed?.patch || null, skip: true };
  return { id, start: parsed.start, patch: parsed.patch, m, side: me.teamId === 100 ? 'b' : 'r', role };
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

// "16.9" < "16.21"
const olderPatch = (a, b) => {
  const [x, y] = [a, b].map((p) => String(p).split('.').map(Number));
  return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
};

/** A player's games of this patch (new ones fetched), or [] when the account is not found */
async function patchGames(api, riotId, patch, log) {
  const account = await resolveAccount(api, riotId);
  if (!account) {
    log('players: a Riot ID was not found, skipped');
    return [];
  }
  const { puuid, region } = account;
  const cache = loadCache(puuid);
  if (region) {
    const since = Math.floor((Date.now() - LOOKBACK_DAYS * 86_400_000) / 1000);
    fs.mkdirSync(DIR, { recursive: true });
    for (const queue of QUEUES) {
      let older = false;
      for (let start = 0; start < MAX_GAMES && !older; start += PAGE) {
        const ids = (await api.get(region, `/lol/match/v5/matches/by-puuid/${puuid}/ids`, { queue, start, count: PAGE, startTime: since })) || [];
        for (const id of ids) {
          let g = cache.get(id);
          if (!g) {
            g = historyGame(await api.get(region, `/lol/match/v5/matches/${id}`), puuid);
            if (!g.id) continue;
            cache.set(g.id, g);
            fs.appendFileSync(fileFor(puuid), `${JSON.stringify(g)}\n`);
          }
          // Newest first: once a match of an older patch shows up, the rest are older too
          if (g.patch && olderPatch(g.patch, patch)) {
            older = true;
            break;
          }
        }
        if (ids.length < PAGE) break;
      }
    }
  }
  return [...cache.values()].filter((g) => !g.skip && g.patch === patch);
}

module.exports = { patchGames, historyGame, resolveAccount };
