// Riot API source: collects new Diamond+ matches into the raw counters, then
// computes meta / synergy / matchup from all counters of the current patch.
//
// .env settings:
//   RIOT_API_KEY           required
//   RIOT_PLATFORMS         comma-separated servers (default: all)
//   RIOT_TIME_BUDGET_MIN   minutes spent collecting matches (default 40)
//   RIOT_LOOKBACK_DAYS     how many days back to look (default 7)
//   RIOT_MAX_PER_REGION    max new matches per region, 0 = no limit (default 0)
//   RIOT_RATE_LIMITS       "requests:seconds,..." (default development key: 20:1,100:120)

const { RiotClient } = require('../riot/client');
const { crawl, PLATFORMS } = require('../riot/crawl');
const { score } = require('../riot/score');
const store = require('../riot/store');

const DRY_RUN_MAX_PER_REGION = 5;

module.exports = {
  name: 'riot',
  async collect({ env, log, client, dryRun }) {
    const api = new RiotClient({ key: env.RIOT_API_KEY, limits: env.RIOT_RATE_LIMITS || '20:1,100:120', log });
    const patch = await store.currentPatch(client);
    const platforms = env.RIOT_PLATFORMS
      ? env.RIOT_PLATFORMS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : Object.keys(PLATFORMS);
    const minutes = dryRun ? 3 : Number(env.RIOT_TIME_BUDGET_MIN) || 40;
    const lookbackDays = Number(env.RIOT_LOOKBACK_DAYS) || 7;

    log(`patch ${patch} · ${platforms.length} servers · ${minutes} min${dryRun ? ' · dry run (no writes)' : ''}`);
    const crawlStats = await crawl({
      api,
      patch,
      platforms,
      deadline: Date.now() + minutes * 60_000,
      since: Date.now() - lookbackDays * 86_400_000,
      maxPerRegion: dryRun ? DRY_RUN_MAX_PER_REGION : Number(env.RIOT_MAX_PER_REGION) || 0,
      filterUnseen: (ids) => store.filterUnseen(client, ids),
      ingest: dryRun ? async (m) => m.length : (m) => store.ingest(client, m),
      log,
    });
    log(`riot: ${api.requests} requests`);

    const agg = await store.loadAggregates(client, patch);
    log(`patch ${patch} total: ${agg.matches} matches`);
    return { patch, ...score(agg), stats: { patch, totalMatches: agg.matches, requests: api.requests, regions: crawlStats } };
  },
};
