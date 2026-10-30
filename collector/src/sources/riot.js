// Riot API source: collects new Diamond+ matches into the raw counters, then
// computes meta / synergy / matchup from all counters of the current patch.
//
// Order of work, most important first:
//   1. the team's players (their games and statistics): first, and again every
//      PLAYERS_EVERY_MS; their requests go ahead of everything else while they run
//   2. general matches from every server, for the model
//   3. build data: starting items from the timelines of the stored matches, in the last
//      BUILD_SHARE of the time (or earlier if the crawl runs out of players)
// Runes, final items and summoner spells come with the matches themselves.
//
// Every new match is also stored as a single row on this computer. The win model
// (src/model) is trained on them about once an hour, in a background thread and only
// while no game is running; after collecting it waits up to 3 hours for a free
// computer to train the final model.
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
//   RIOT_LOOKBACK_DAYS     how many days back to look (default 28; only the current patch counts)
//   RIOT_DIAMOND_PAGES     Diamond ladder pages per division and server (default 5)
//   RIOT_MAX_PER_REGION    max new matches per region, 0 = no limit (default 0)
//   RIOT_RATE_LIMITS       starting rate limit "requests:seconds,..." (default development
//                          key 20:1,100:120); the real limit reported by Riot replaces it

const { RiotClient } = require('../riot/client');
const { crawl, PLATFORMS } = require('../riot/crawl');
const { score } = require('../riot/score');
const store = require('../riot/store');
const model = require('../model');
const players = require('../players');
const { collectStarts } = require('../riot/timelines');
const fs = require('node:fs');
const path = require('node:path');

const DRY_RUN_MAX_PER_REGION = 5;
const TRAIN_EVERY_MS = 60 * 60_000;
const TRAIN_CHECK_MS = 5 * 60_000;
// The team's players come first: their matches are read and analyzed before the general
// crawl starts, then again this often (they are few, so it is quick)
const PLAYERS_EVERY_MS = 2 * 60 * 60_000;
const FINAL_TRAIN_WAIT_MS = 3 * 60 * 60_000;
const BUILD_SHARE = 0.15; // of the time budget, kept for build data after the crawl
// scripts/schedule-windows.ps1 -Stop creates this file: stop cleanly, like Ctrl+C
const STOP_FILE = path.join(__dirname, '..', '..', 'data', 'stop');
const STOP_CHECK_MS = 30_000;
const DB_TRIES = 5;
const OFFLINE_MAX_MS = 3 * 60 * 60_000; // a lost connection is waited out this long

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Database calls can time out under load: retry with growing pauses instead of
// stopping a region. A lost connection does not count as a try; it is waited out.
// Returns fallback() if every try fails.
const isNetworkError = (err) => /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(String(err?.message || err));
async function withRetry(what, fn, log, fallback) {
  let offlineSince = null;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isNetworkError(err)) {
        if (offlineSince === null) {
          offlineSince = Date.now();
          log(`${what}: connection lost, waiting for the network`);
        }
        if (Date.now() - offlineSince < OFFLINE_MAX_MS) {
          attempt = 0;
          await sleep(60_000);
          continue;
        }
      }
      if (attempt >= DB_TRIES) {
        log(`${what} failed ${DB_TRIES} times (${err.message}); skipped`);
        return fallback();
      }
      log(`${what} failed (${err.message}), retrying in ${10 * attempt}s`);
      await sleep(10_000 * attempt);
    }
  }
}

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
    const lookbackDays = Number(env.RIOT_LOOKBACK_DAYS) || 28;

    // Ctrl+C: stop collecting, then score and save what we have
    const stop = { reason: null };
    process.once('SIGINT', () => {
      stop.reason = 'interrupted';
      log('stopping: finishing the current requests and saving (Ctrl+C again to quit now)');
      process.once('SIGINT', () => process.exit(130));
    });
    fs.rmSync(STOP_FILE, { force: true }); // an old request must not stop a new run
    const stopWatch = setInterval(() => {
      if (stop.reason || !fs.existsSync(STOP_FILE)) return;
      fs.rmSync(STOP_FILE, { force: true });
      stop.reason = 'requested';
      log('stop requested: finishing the current requests and saving');
    }, STOP_CHECK_MS);

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

    // Model training: about once an hour, when the computer is free
    let lastTrain = 0;
    let training = null;
    let lastPlayers = 0;
    const trainTimer = dryRun
      ? null
      : setInterval(() => {
          if (training || Date.now() - lastTrain < TRAIN_EVERY_MS) return;
          training = model
            .trainAndPublish({ client, patch, log })
            .then((m) => {
              if (m) lastTrain = Date.now();
            })
            .catch((err) => log(`model training failed (${err.message})`))
            .finally(() => (training = null));
        }, TRAIN_CHECK_MS);

    // Team players first, then on a timer alongside the crawl
    let playersRun = null;
    const updatePlayers = () => {
      if (dryRun || playersRun) return playersRun;
      lastPlayers = Date.now();
      playersRun = api
        .first((fast) => players.updatePlayers({ client, api: fast, log }))
        .catch((err) => log(`player analysis failed (${err.message})`))
        .finally(() => (playersRun = null));
      return playersRun;
    };
    await updatePlayers();
    const playersTimer = dryRun ? null : setInterval(() => {
      if (Date.now() - lastPlayers >= PLAYERS_EVERY_MS) updatePlayers();
    }, TRAIN_CHECK_MS);

    log(`patch ${patch} · ${platforms.length} servers · up to ${minutes} min${dryRun ? ' · dry run (no writes)' : ''}`);
    const end = Date.now() + minutes * 60_000;
    const crawlStats = await crawl({
      api,
      patch,
      platforms,
      stop,
      deadline: end - minutes * 60_000 * BUILD_SHARE,
      since: Date.now() - lookbackDays * 86_400_000,
      maxPerRegion: dryRun ? DRY_RUN_MAX_PER_REGION : Number(env.RIOT_MAX_PER_REGION) || 0,
      diamondPages: dryRun ? 1 : Number(env.RIOT_DIAMOND_PAGES) || 5,
      // If the check fails, all ids go on: saving skips matches already counted
      filterUnseen: (ids) => withRetry('checking matches', () => store.filterUnseen(client, ids), log, () => ids),
      ingest: dryRun
        ? async (m) => m.length
        : async (m) => {
            // Local copy first, so the model never loses matches to a database hiccup
            model.storeMatches(patch, m);
            const added = await withRetry('saving matches', () => store.ingest(client, m), log, () => 0);
            maybeRescore();
            return added;
          },
      log,
    });
    // Build data with the time left
    if (!dryRun && !stop.reason) {
      await collectStarts({ api, matches: model.loadMatches(patch), deadline: end, stop, log, store: (rows) => model.storeStarts(patch, rows) })
        .catch((err) => log(`build data failed (${err.message})`));
    }
    clearInterval(trainTimer);
    clearInterval(playersTimer);
    clearInterval(stopWatch);
    await playersRun;
    await rescoring;
    await training;
    log(`riot: ${api.requests} requests${stop.reason ? ` · stopped (${stop.reason})` : ''}`);

    const output = await scoreNow();
    log(`patch ${patch} total: ${output.totalMatches} matches`);
    if (!dryRun) {
      await model
        .trainAndPublish({ client, patch, log, waitMs: FINAL_TRAIN_WAIT_MS })
        .catch((err) => log(`model training failed (${err.message})`));
    }
    return {
      ...output,
      stats: { patch, totalMatches: output.totalMatches, requests: api.requests, stoppedBy: stop.reason, regions: crawlStats },
    };
  },
};
