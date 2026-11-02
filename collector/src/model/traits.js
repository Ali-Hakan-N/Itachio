// Champion traits measured from matches, on the 0-3 scale of the hand-scored table
// (desktop/src/renderer/traits.js), so a new champion has a profile before anyone scores it
// and existing scores follow what champions actually do. Pure function.
//
//   mg  magic share of the damage dealt to champions (0-1)
//   cc  seconds of crowd control on others per minute
//   fr  share of the damage a champion takes among what it takes and deals
// cc and fr are placed by their rank among all measured champions: the top quarter of
// champions is about 3, the bottom quarter about 0. n is the number of games measured.

const MIN_GAMES = 50;
const FULL_SCALE = 3;

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Rank of every value among the values, 0-3 */
function ranked(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const last = Math.max(1, sorted.length - 1);
  return (v) => (sorted.findLastIndex((x) => x <= v) / last) * FULL_SCALE;
}

/** matches: compact matches. Returns { "<champion>": { mg, cc, fr, n } }, fr only with damage taken numbers */
function traitProfiles(matches) {
  const sums = new Map();
  for (const m of matches) {
    if (!m.xb || !m.xr || !m.d) continue;
    const minutes = m.d / 60;
    for (const [team, facts] of [[m.b, m.xb], [m.r, m.xr]]) {
      team.forEach((champion, role) => {
        const x = facts[role];
        if (!x || x.slice(0, 4).some((v) => v === null)) return;
        const t = sums.get(champion) || { magic: 0, dealt: 0, cc: 0, taken: 0, takenDealt: 0, n: 0 };
        t.magic += x[0];
        t.dealt += x[0] + x[1];
        t.cc += x[3] / minutes;
        if (Number.isFinite(x[4])) {
          t.taken += x[4];
          t.takenDealt += x[0] + x[1];
        }
        t.n++;
        sums.set(champion, t);
      });
    }
  }
  const measured = [...sums].filter(([, t]) => t.n >= MIN_GAMES);
  const ccRank = ranked(measured.map(([, t]) => t.cc / t.n));
  const frontShare = (t) => t.taken / (t.taken + t.takenDealt);
  const frRank = ranked(measured.filter(([, t]) => t.taken).map(([, t]) => frontShare(t)));
  return Object.fromEntries(measured.map(([champion, t]) => [champion, {
    mg: round(t.dealt ? t.magic / t.dealt : 0.5, 3),
    cc: round(ccRank(t.cc / t.n), 2),
    ...(t.taken ? { fr: round(frRank(frontShare(t)), 2) } : {}),
    n: t.n,
  }]));
}

module.exports = { traitProfiles, MIN_GAMES };
