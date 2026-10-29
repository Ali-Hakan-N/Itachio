// Turns matches into features for the win model. Pure functions.
//
// A compact match: { id, q, w, b, r }
//   b / r: blue / red champion ids by role [top, jungle, middle, bottom, utility]
//   w: 1 when blue won
//
// Features, seen from blue (+1 for blue, -1 for red):
//   c:<champ>:<role>                 champion strength in a role
//   o:<role>                         off-role: -ln(share of the champion's games in that role)
//   s:<a>:<ra>:<b>:<rb>              two champions on the same team (synergy)
//   v:<a>:<ra>:<b>:<rb>              a against b on the enemy team (matchup), +1 when blue is a
//   ts:<classA>:<classB>             class pair on the same team (Mage + Tank ...)
//   tv:<classA>:<classB>             class against class
// Pair keys are canonical (lower champion:role first), so each pair has one weight.
// Matchups and class matchups are antisymmetric: b against a is minus a against b.

const ROLES = ['top', 'jungle', 'middle', 'bottom', 'utility'];
const ROLE_INDEX = Object.fromEntries(ROLES.map((r, i) => [r, i]));
const SHARE_FLOOR = 0.002;

/** Parsed match (riot/parse.js) -> compact match, or null if roles are incomplete */
function toCompact(m) {
  const b = new Array(5).fill(0);
  const r = new Array(5).fill(0);
  let blueWon = null;
  for (const p of m.p) {
    const i = ROLE_INDEX[p.r];
    if (i === undefined) return null;
    const team = p.t === 100 ? b : r;
    if (team[i]) return null; // two players in one role
    team[i] = p.c;
    if (p.t === 100) blueWon = p.w;
  }
  if (b.includes(0) || r.includes(0) || blueWon === null) return null;
  return { id: m.id, q: m.queue, w: blueWon ? 1 : 0, b, r };
}

/** Share of each champion's games played in each role: Map "champ:role" -> share */
function roleShares(matches) {
  const byRole = new Map();
  const total = new Map();
  for (const m of matches) {
    for (const team of [m.b, m.r]) {
      team.forEach((c, i) => {
        byRole.set(`${c}:${i}`, (byRole.get(`${c}:${i}`) || 0) + 1);
        total.set(c, (total.get(c) || 0) + 1);
      });
    }
  }
  const share = new Map();
  for (const [key, n] of byRole) share.set(key, n / total.get(Number(key.split(':')[0])));
  return { share, games: byRole };
}

const offRole = (share, c, i) => -Math.log(Math.max(share.get(`${c}:${i}`) || 0, SHARE_FLOOR));
const before = (a, ra, b, rb) => a * 5 + ra < b * 5 + rb;

/**
 * @param {{b:number[], r:number[]}} m
 * @param {{ share: Map<string, number>, tagOf: (id:number)=>string }} ctx
 * @returns {Array<[string, number]>}
 */
function features(m, { share, tagOf }) {
  const out = [];
  const teams = [[m.b, 1], [m.r, -1]];
  for (const [team, sign] of teams) {
    for (let i = 0; i < 5; i++) {
      out.push([`c:${team[i]}:${i}`, sign]);
      out.push([`o:${i}`, sign * offRole(share, team[i], i)]);
      for (let j = i + 1; j < 5; j++) {
        const [a, ra, b, rb] = before(team[i], i, team[j], j) ? [team[i], i, team[j], j] : [team[j], j, team[i], i];
        out.push([`s:${a}:${ra}:${b}:${rb}`, sign]);
        const [ta, tb] = [tagOf(team[i]), tagOf(team[j])].sort();
        out.push([`ts:${ta}:${tb}`, sign]);
      }
    }
  }
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const [x, y] = [m.b[i], m.r[j]];
      if (before(x, i, y, j)) out.push([`v:${x}:${i}:${y}:${j}`, 1]);
      else out.push([`v:${y}:${j}:${x}:${i}`, -1]);
      const [tx, ty] = [tagOf(x), tagOf(y)];
      if (tx < ty) out.push([`tv:${tx}:${ty}`, 1]);
      else if (tx > ty) out.push([`tv:${ty}:${tx}`, -1]);
    }
  }
  return out;
}

const groupOf = (key) => key.slice(0, key.indexOf(':'));

module.exports = { ROLES, ROLE_INDEX, SHARE_FLOOR, toCompact, roleShares, features, groupOf };
