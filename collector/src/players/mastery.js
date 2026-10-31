// Champion mastery (champion-mastery-v4) as a 0-1 "comfort" value per champion, never as a
// raw score: analyze.js only uses it to loosen how hard a player's own results are
// shrunk. Three parts multiply:
//   rank     the champion's place among the player's own champions by log points
//   level    log points against POINTS_FULL (a few hundred thousand points is full)
//   recency  halves every HALF_LIFE_DAYS since the player last played it

const HALF_LIFE_DAYS = 180;
const POINTS_FULL = 5.5; // log10(316k)
const DAY_MS = 86_400_000;

/** list: [{ championId, championPoints, lastPlayTime }] -> Map champion id -> 0..1 */
function masteryWeights(list, now = Date.now()) {
  const rows = (list || []).filter((x) => x.championPoints > 0)
    .map((x) => ({ id: x.championId, log: Math.log10(1 + x.championPoints), days: Math.max(0, (now - (x.lastPlayTime || 0)) / DAY_MS) }))
    .sort((a, b) => a.log - b.log);
  return new Map(rows.map((r, i) => [
    r.id,
    ((i + 1) / rows.length) * Math.min(1, r.log / POINTS_FULL) * 0.5 ** (r.days / HALF_LIFE_DAYS),
  ]));
}

module.exports = { masteryWeights };
