// Collects Diamond+ matches.
// Regions (americas, europe, asia, sea) run in parallel; Riot's limits are per region.
// Inside a region Flex comes first: Flex matches of Diamond+ players on the Flex
// ladder, until no new matches are left or time runs out. The rest goes to Solo/Duo.
// The whole current patch is collected: up to IDS_PER_PLAYER of each player's newest
// matches, newest first, stopping at the first match of an older patch (everything
// after it is older too), so no requests go to matches that would not count.

const { parseMatch } = require('./parse');
const { RiotKeyError } = require('./client');

const IDS_PER_PLAYER = 100; // the most match-v5 returns per request
const TIMELINE_EVERY = 8; // one match in this many is also read with its timeline (starting items)

// "16.9" < "16.21"
const olderPatch = (a, b) => {
  const [x, y] = [a, b].map((p) => p.split('.').map(Number));
  return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
};

// Server -> match-v5 region
const PLATFORMS = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', sg2: 'sea', tw2: 'sea', vn2: 'sea',
};

const QUEUES = [
  { id: 440, ladder: 'RANKED_FLEX_SR', name: 'Flex' },
  { id: 420, ladder: 'RANKED_SOLO_5x5', name: 'Solo/Duo' },
];

const APEX = ['challengerleagues', 'grandmasterleagues', 'masterleagues'];
const DIAMOND = ['I', 'II', 'III', 'IV'];
const FLUSH_EVERY = 50;

function shuffle(list, random = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Diamond+ players (puuid) of one ladder on one server */
async function ladderPlayers(api, platform, ladder, diamondPages = 1) {
  const puuids = new Set();
  for (const apex of APEX) {
    const league = await api.get(platform, `/lol/league/v4/${apex}/by-queue/${ladder}`);
    for (const e of league?.entries || []) if (e.puuid) puuids.add(e.puuid);
  }
  for (const div of DIAMOND) {
    for (let page = 1; page <= diamondPages; page++) {
      const entries = await api.get(platform, `/lol/league/v4/entries/${ladder}/DIAMOND/${div}`, { page });
      for (const e of entries || []) if (e.puuid) puuids.add(e.puuid);
      if (!entries || entries.length < 200) break; // last page
    }
  }
  return [...puuids];
}

/**
 * @param {object} o
 * @param {import('./client').RiotClient} o.api
 * @param {string} o.patch             only matches of this patch count ("16.21")
 * @param {string[]} o.platforms
 * @param {number} o.deadline          ms; no new requests start after this
 * @param {number} o.since             start of the match search window (ms)
 * @param {number} [o.maxPerRegion]    0 = no limit
 * @param {number} [o.diamondPages]    Diamond ladder pages per division (205 players each)
 * @param {{reason:string|null}} [o.stop]  shared: set reason to stop every region (expired key, Ctrl+C)
 * @param {(ids:string[])=>Promise<string[]>} o.filterUnseen
 * @param {(matches:object[])=>Promise<number>} o.ingest
 */
async function crawl(o) {
  o = { stop: { reason: null }, ...o };
  const byRegion = new Map();
  for (const p of o.platforms) {
    const region = PLATFORMS[p];
    if (!region) {
      o.log(`unknown server skipped: ${p}`);
      continue;
    }
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(p);
  }
  const results = await Promise.all([...byRegion].map(([region, platforms]) => crawlRegion({ ...o, region, platforms })));
  return Object.fromEntries(results.map((r) => [r.region, r]));
}

async function crawlRegion(o) {
  const { api, region, log } = o;
  const stats = { region, matches: 0, read: 0, otherPatch: 0, skipped: 0, byQueue: {} };
  const seen = new Set();
  let buffer = [];
  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    stats.matches += await o.ingest(batch);
  };
  const timeLeft = () => Date.now() < o.deadline && !o.stop.reason;
  const full = () => o.maxPerRegion > 0 && stats.matches + buffer.length >= o.maxPerRegion;

  try {
    for (const queue of QUEUES) {
      if (!timeLeft() || full()) break;
      const before = stats.matches + buffer.length;

      // Player lists per server; a server that fails is skipped
      const lists = await Promise.all(
        o.platforms.map((p) =>
          ladderPlayers(api, p, queue.ladder, o.diamondPages).catch((err) => {
            if (err instanceof RiotKeyError) throw err;
            log(`${p} ${queue.name}: could not load players (${err.message}), skipped`);
            return [];
          }),
        ),
      );
      const pools = lists.map((l, i) => ({ platform: o.platforms[i], players: shuffle(l, o.random) }));
      log(`${region} ${queue.name}: players ${pools.map((p) => `${p.platform} ${p.players.length}`).join(', ')}`);

      // Take one player per server in turn and process their new matches
      while (timeLeft() && !full()) {
        const active = pools.filter((p) => p.players.length);
        if (!active.length) break; // no players left in this queue
        for (const pool of active) {
          if (!timeLeft() || full()) break;
          const puuid = pool.players.pop();
          const ids = await api.get(region, `/lol/match/v5/matches/by-puuid/${puuid}/ids`, {
            queue: queue.id, startTime: Math.floor(o.since / 1000), count: IDS_PER_PLAYER,
          });
          const fresh = [];
          for (const id of ids || []) {
            if (seen.has(id)) continue;
            seen.add(id);
            fresh.push(id);
          }
          for (const id of await o.filterUnseen(fresh)) {
            if (!timeLeft() || full()) break;
            const raw = await api.get(region, `/lol/match/v5/matches/${id}`);
            let parsed = parseMatch(raw);
            // One match in TIMELINE_EVERY of the patch is also read with its timeline, for
            // starting items (a second request, so not every match)
            if (parsed && parsed.patch === o.patch && ++stats.read % TIMELINE_EVERY === 0) {
              const timeline = await api.get(region, `/lol/match/v5/matches/${id}/timeline`).catch((err) => {
                if (err instanceof RiotKeyError) throw err;
                return null;
              });
              if (timeline) parsed = parseMatch(raw, timeline) || parsed;
            }
            if (!parsed) stats.skipped++;
            else if (parsed.patch !== o.patch) {
              stats.otherPatch++;
              if (olderPatch(parsed.patch, o.patch)) break; // the rest of this player's list is older
            } else buffer.push(parsed);
            if (buffer.length >= FLUSH_EVERY) await flush();
          }
        }
      }
      await flush();
      stats.byQueue[queue.name] = stats.matches - before;
      log(`${region} ${queue.name}: ${stats.byQueue[queue.name]} new matches`);
    }
  } catch (err) {
    if (err instanceof RiotKeyError) {
      // The key expired (development keys last 24 hours): stop everywhere, keep what we have
      if (!o.stop.reason) log(`${err.message}. Stopping and saving what was collected.`);
      o.stop.reason = 'key';
    } else {
      // Only this region stops; the others keep going
      log(`${region}: stopped after an error (${err.message})`);
      stats.error = err.message;
    }
  } finally {
    await flush().catch((err) => log(`${region}: could not write the last batch (${err.message})`));
  }
  return stats;
}

module.exports = { crawl, PLATFORMS, QUEUES };
