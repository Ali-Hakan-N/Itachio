// Build data, read after the general crawl: starting items from match timelines (a second
// request per match, so it waits until the matches themselves are in). Stored matches of
// the patch that know their players' participant ids (ib/ir) and have no starting items
// yet are read newest first, every region in parallel, until the deadline or MAX_PER_RUN.
// Results go next to the matches (model/index.js storeStarts) and reach the builds with
// the next training.

const { startingItems } = require('./parse');
const { PLATFORMS } = require('./crawl');
const { RiotKeyError } = require('./client');

const MAX_PER_RUN = 40000;
const FLUSH_EVERY = 50;

/** Starting items of a stored match from its timeline: { id, sb, sr } or null */
function startsOf(m, timeline) {
  const items = startingItems(timeline);
  if (!items.size) return null;
  const side = (ids) => ids.map((pid) => items.get(pid) || null);
  return { id: m.id, sb: side(m.ib), sr: side(m.ir) };
}

/**
 * @param o { api, matches (compact, oldest first), deadline, stop, store(rows), log }
 * @returns number of matches given starting items
 */
async function collectStarts(o) {
  const { api, log } = o;
  const byRegion = new Map();
  let wanted = 0;
  for (let i = o.matches.length - 1; i >= 0 && wanted < MAX_PER_RUN; i--) {
    const m = o.matches[i];
    if (m.sb || !m.ib || !m.ir) continue;
    const region = PLATFORMS[String(m.id).split('_')[0].toLowerCase()];
    if (!region) continue;
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(m);
    wanted++;
  }
  if (!wanted) {
    log('build data: every stored match with player ids has its starting items');
    return 0;
  }
  log(`build data: reading starting items of up to ${wanted} matches`);
  const timeLeft = () => Date.now() < o.deadline && !o.stop?.reason;
  const results = await Promise.all([...byRegion].map(async ([region, list]) => {
    let done = 0;
    let buffer = [];
    const flush = () => {
      if (buffer.length) o.store(buffer);
      buffer = [];
    };
    try {
      for (const m of list) {
        if (!timeLeft()) break;
        const timeline = await api.get(region, `/lol/match/v5/matches/${m.id}/timeline`);
        const row = timeline && startsOf(m, timeline);
        if (!row) continue;
        buffer.push(row);
        done++;
        if (buffer.length >= FLUSH_EVERY) flush();
      }
    } catch (err) {
      if (err instanceof RiotKeyError) {
        if (o.stop && !o.stop.reason) o.stop.reason = 'key';
      } else log(`build data: ${region} stopped after an error (${err.message})`);
    } finally {
      flush();
    }
    return done;
  }));
  const total = results.reduce((a, n) => a + n, 0);
  log(`build data: starting items of ${total} matches`);
  return total;
}

module.exports = { collectStarts, startsOf };
