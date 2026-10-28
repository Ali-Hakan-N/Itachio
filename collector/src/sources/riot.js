// Riot API source: collects new Diamond+ matches into the raw counters, then
// computes meta / synergy / matchup from all counters of the current patch.
//
// It runs until the time budget ends, the key expires (development keys last
// 24 hours) or Ctrl+C. Scores are also refreshed every RIOT_RESCORE_MIN minutes
// while it runs. Ctrl+C stops cleanly and saves; a second Ctrl+C quits at once.
//
// .env settings:
//   RIOT_API_KEY           required
//   RIOT_PLATFORMS         comma-separated servers (default: all)
//   RIOT_TIME_BUDGET_MIN   minutes spent collecting matches (default 1380 = 23 hours)
//   RIOT_RESCORE_MIN       refresh scores every N minutes during the run (default 60)
//   RIOT_LOOKBACK_DAYS     how many days back to look (default 7)
//   RIOT_DIAMOND_PAGES     Diamond ladder pages per division and server (default 5)
//   RIOT_MAX_PER_REGION    max new matches per region, 0 = no limit (default 0)
//   RIOT_RATE_LIMITS       starting rate limit "requests:seconds,..." (default development
//                          key 20:1,100:120); the real limit reported by Riot replaces it

const { RiotClient } = require('../riot/client');
const { crawl, PLATFORMS } = require('../riot/crawl');
const { score } = require('../riot/score');
const store = require('../riot/store');

const DRY_RUN_MAX_PER_REGION = 5;

module.exports = {
  name: 'riot',
  async collect({ env, log, client, dryRun, publish }) {
    const api = new RiotClient({ key: env.RIOT_API_KEY, limits: env.RIOT_RATE_LIMITS || '20:1,100:120', log });
    const patch = await store.currentPatch(client);
    const platforms = env.RIOT_PLATFORMS
      ? env.RIOT_PLATFORMS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : Object.keys(PLATFORMS);
    const minutes = dryRun ? 3 : Number(env.RIOT_TIME_BUDGET_MIN) || 1380;
    const rescoreMs = (Number(env.RIOT_RESCORE_MIN) || 60) * 60_000;
    const lookbackDays = Number(env.RIOT_LOOKBACK_DAYS) || 7;

    // Ctrl+C: stop collecting, then score and save what we have
    const stop = { reason: null };
    process.once('SIGINT', () => {
      stop.reason = 'interrupted';
      log('stopping: finishing the current requests and saving (Ctrl+C again to quit now)');
      process.once('SIGINT', () => process.exit(130));
    });

    // Fresh scores during a long run, at most one refresh at a time
    let lastRescore = Date.now();
    let rescoring = null;
    const scoreNow = async () => {
      const agg = await store.loadAggregates(client, patch);
      return { patch, ...score(agg), totalMatches: agg.matches };
    };
    const maybeRescore = () => {
      if (dryRun || !publish || rescoring || Date.now() - lastRescore < rescoreMs) return;
      lastRescore = Date.now();
      log('refreshing scores');
      rescoring = scoreNow()
        .then(publish)
        .catch((err) => log(`score refresh failed (${err.message})`))
        .finally(() => (rescoring = null));
    };

    log(`patch ${patch} · ${platforms.length} servers · up to ${minutes} min${dryRun ? ' · dry run (no writes)' : ''}`);
    const crawlStats = await crawl({
      api,
      patch,
      platforms,
      stop,
      deadline: Date.now() + minutes * 60_000,
      since: Date.now() - lookbackDays * 86_400_000,
      maxPerRegion: dryRun ? DRY_RUN_MAX_PER_REGION : Number(env.RIOT_MAX_PER_REGION) || 0,
      diamondPages: dryRun ? 1 : Number(env.RIOT_DIAMOND_PAGES) || 5,
      filterUnseen: (ids) => store.filterUnseen(client, ids),
      ingest: dryRun
        ? async (m) => m.length
        : async (m) => {
            const added = await store.ingest(client, m);
            maybeRescore();
            return added;
          },
      log,
    });
    await rescoring;
    log(`riot: ${api.requests} requests${stop.reason ? ` · stopped (${stop.reason})` : ''}`);

    const output = await scoreNow();
    log(`patch ${patch} total: ${output.totalMatches} matches`);
    return {
      ...output,
      stats: { patch, totalMatches: output.totalMatches, requests: api.requests, stoppedBy: stop.reason, regions: crawlStats },
    };
  },
};
