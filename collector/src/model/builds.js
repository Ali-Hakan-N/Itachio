// Recommended runes, items and summoner spells per champion and role, from the matches.
//
// Every player's runes, final items and spells are recorded with the match (riot/parse.js
// gearOf, GEAR below). For each champion and role:
//   runes   the keystone (with its tree) among those used in at least MIN_SHARE of games,
//           chosen by win rate shrunk toward the champion's own (PRIOR games), so a page
//           that won a few games cannot beat a common one; then for that keystone the most
//           used rune in every slot, the most used secondary tree and pair, and shards
//   items   the completed items players end with most often (popularity first: the
//           core is what most players build), and the most common boots when at least
//           BOOTS_SHARE of players end with boots (many sell them late)
//   spells  the most common pair
//   start   the most common set of starting items (matches read with their timeline),
//           with at least START_MIN such games
//   pool    every completed item (and boots) at least POOL_SHARE of players end with: the
//           champion's real choices, from which the app picks situational items
// Situational items (analyzeSituations): what an item is worth against the enemy team,
// learned from results. Every champion has a profile measured from the matches (PROFILE:
// share of its damage that is magic, healing per minute, seconds of crowd control on
// others per minute, and whether it is an assassin), standardized over champions; an
// enemy team's profile is the sum over its five. For every player-game the result is
// compared with the win rate of the champion in that role with as many completed items
// (the item count stands in for game length, which items depend on), and with what the
// enemy profile does to every player in that role (a regression over all their games:
// facing assassins goes better or worse for everyone, whatever they build). For each
// item, a ridge regression of what is left over its buyers' games on the enemy team's
// profile gives what one unit of each part is worth to a buyer; parts within Z_KEEP
// standard errors of zero are left out. Armor against physical damage, magic resist against
// magic, Quicksilver against crowd control, Grievous Wounds against healing, Zhonya's
// against assassins: none of it is told, it is what the buyers' results show.
// Learning per item and enemy champion directly was tried: far too noisy for the games
// a patch has.
// Builds also depend on the other team: besides the general build ('any'), one is made
// for enemy teams of mostly magic ('ap'), mostly physical ('ad') and mixed damage, where
// there are at least BUCKET_MIN games. A team's magic share is the mean of its champions'
// magic / (magic + attack) ratings (Data Dragon); the thresholds are the lower and upper
// thirds of all teams, so each bucket holds about a third of the games.

const GEAR = { primary: 0, keystone: 1, sub: 5, shards: 8, items: 11, spells: 17 };
const MIN_GAMES = 30; // general build
const BUCKET_MIN = 80; // build against one kind of damage
const MIN_SHARE = 0.25; // a keystone must be this common to be chosen (popularity first)
const PRIOR = 200; // games of the champion's own win rate a keystone starts from
const BOOTS_SHARE = 0.2;
const CORE = 3;
const MORE = 4;
const START_MIN = 15; // games with starting items
const POOL_SHARE = 0.03;
const PROFILE = ['magic', 'heal', 'cc', 'assassin'];
const PROFILE_MIN = 20; // games with damage, healing and crowd control numbers for a measured profile
const SIT_MIN = 300; // buyer games to learn an item's situations
const RIDGE = 200; // penalty on the profile weights, in games
const Z_KEEP = 1.5;
const CELL_PRIOR = 20; // games of the champion's role win rate a cell starts from

const DDRAGON = 'https://ddragon.leagueoflegends.com/cdn';

/** Item and champion facts from Data Dragon: completed items, boots, shop items, magic share per champion */
async function loadDdragon(version, fetchFn = globalThis.fetch) {
  const get = async (file) => {
    const res = await fetchFn(`${DDRAGON}/${version}/data/en_US/${file}`);
    if (!res.ok) throw new Error(`Data Dragon ${file}: HTTP ${res.status}`);
    return res.json();
  };
  const [items, champions] = await Promise.all([get('item.json'), get('champion.json')]);
  const completed = new Set();
  const boots = new Set();
  const shop = new Set(); // anything that can start a game (potions too), trinkets aside
  for (const [id, it] of Object.entries(items.data)) {
    if (!it.maps?.['11'] || it.tags?.includes('Trinket')) continue;
    if (it.gold?.purchasable !== false) shop.add(Number(id));
    if (it.tags?.includes('Consumable')) continue;
    if (it.tags?.includes('Boots') && (it.depth || 1) >= 2) boots.add(Number(id));
    // Final items, including ones that are not bought but transformed into (Muramana)
    else if (!(it.into || []).length && it.gold.total >= 1600) completed.add(Number(id));
  }
  const magic = {};
  const assassin = new Set();
  for (const c of Object.values(champions.data)) {
    if (c.tags?.includes('Assassin')) assassin.add(Number(c.key));
    const { attack = 0, magic: m = 0 } = c.info || {};
    magic[Number(c.key)] = attack + m ? m / (attack + m) : 0.5;
  }
  return { completed, boots, shop, magic, assassin };
}

const mode = (values) => {
  const count = new Map();
  for (const v of values) count.set(v, (count.get(v) || 0) + 1);
  let best = null;
  for (const [v, n] of count) if (!best || n > best.n) best = { v, n };
  return best ? best.v : null;
};

function pickRunes(games) {
  const base = games.reduce((a, g) => a + g.win, 0) / games.length;
  const byKey = new Map();
  for (const g of games) {
    const k = `${g.gear[GEAR.primary]}:${g.gear[GEAR.keystone]}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(g);
  }
  let best = null;
  for (const [k, list] of byKey) {
    if (list.length < MIN_SHARE * games.length) continue;
    const wins = list.reduce((a, g) => a + g.win, 0);
    const shrunk = (wins + PRIOR * base) / (list.length + PRIOR);
    if (!best || shrunk > best.shrunk) best = { k, list, shrunk };
  }
  if (!best) return null;
  const list = best.list;
  const [primary, keystone] = best.k.split(':').map(Number);
  const slot = (i) => mode(list.map((g) => g.gear[i]));
  const sub = slot(GEAR.sub);
  const withSub = list.filter((g) => g.gear[GEAR.sub] === sub);
  const pair = mode(withSub.map((g) => `${g.gear[6]}:${g.gear[7]}`)).split(':').map(Number);
  const shards = mode(list.map((g) => g.gear.slice(GEAR.shards, GEAR.shards + 3).join(':'))).split(':').map(Number);
  return { primary, sub, perks: [keystone, slot(2), slot(3), slot(4), ...pair, ...shards] };
}

function pickItems(games, { completed, boots, shop }) {
  const count = new Map();
  const bootCount = new Map();
  for (const g of games) {
    for (const id of new Set(g.gear.slice(GEAR.items, GEAR.items + 6))) {
      if (completed.has(id)) count.set(id, (count.get(id) || 0) + 1);
      else if (boots.has(id)) bootCount.set(id, (bootCount.get(id) || 0) + 1);
    }
  }
  const ranked = [...count].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const withBoots = [...bootCount.values()].reduce((a, n) => a + n, 0);
  const topBoots = withBoots >= BOOTS_SHARE * games.length ? [...bootCount].sort((a, b) => b[1] - a[1])[0] : null;
  const pool = [...count, ...bootCount].filter(([, n]) => n >= POOL_SHARE * games.length).map(([id]) => id);
  return { core: ranked.slice(0, CORE), more: ranked.slice(CORE, CORE + MORE), boots: topBoots ? topBoots[0] : null, start: pickStart(games, shop), pool };
}

/** The most common set of starting items, or null with too few games read with a timeline */
function pickStart(games, shop) {
  const sets = games.filter((g) => g.start).map((g) => g.start.filter((id) => !shop || shop.has(id)).join(':')).filter(Boolean);
  if (sets.length < START_MIN) return null;
  return mode(sets).split(':').map(Number);
}

/**
 * Champion profiles: { champion: [magic, heal, cc, assassin] }, each standardized over
 * champions (0 is average). Measured from matches with players' numbers (riot/parse.js
 * factsOf) once a champion has PROFILE_MIN of them; until then the magic share comes from
 * Data Dragon and healing and crowd control count as average.
 */
function profiles(matches, facts) {
  const sums = new Map();
  for (const m of matches) {
    if (!m.xb || !m.d) continue;
    const minutes = m.d / 60;
    for (const [team, xs] of [[m.b, m.xb], [m.r, m.xr]]) {
      team.forEach((c, r) => {
        const x = xs[r];
        if (!x || x.some((v) => v === null)) return;
        const t = sums.get(c) || { magic: 0, damage: 0, heal: 0, cc: 0, n: 0 };
        t.magic += x[0];
        t.damage += x[0] + x[1];
        t.heal += x[2] / minutes;
        t.cc += x[3] / minutes;
        t.n++;
        sums.set(c, t);
      });
    }
  }
  const champions = [...new Set([...Object.keys(facts.magic).map(Number), ...sums.keys()])];
  const raw = new Map(champions.map((c) => {
    const t = sums.get(c);
    const measured = t && t.n >= PROFILE_MIN;
    return [c, [
      measured && t.damage ? t.magic / t.damage : facts.magic[c] ?? null,
      measured ? t.heal / t.n : null,
      measured ? t.cc / t.n : null,
      facts.assassin?.has(c) ? 1 : 0,
    ]];
  }));
  const out = {};
  for (const c of champions) out[c] = [];
  PROFILE.forEach((_, f) => {
    const vals = champions.map((c) => raw.get(c)[f]).filter((v) => v !== null);
    const mean = vals.reduce((x, v) => x + v, 0) / (vals.length || 1);
    const sd = Math.sqrt(vals.reduce((x, v) => x + (v - mean) ** 2, 0) / (vals.length || 1)) || 1;
    for (const c of champions) {
      const v = raw.get(c)[f];
      out[c][f] = v === null ? 0 : Math.round(((v - mean) / sd) * 1000) / 1000;
    }
  });
  return out;
}

/** Solves A x = b (small, symmetric positive definite); also returns the diagonal of A^-1 */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i], ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < n; i++) {
    let best = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[best][i])) best = k;
    [M[i], M[best]] = [M[best], M[i]];
    const d = M[i][i];
    for (let j = 0; j < M[i].length; j++) M[i][j] /= d;
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const f = M[k][i];
      for (let j = 0; j < M[k].length; j++) M[k][j] -= f * M[i][j];
    }
  }
  return { x: M.map((row) => row[n]), inv: M.map((row, i) => row[n + 1 + i]) };
}

/**
 * Situational items, see the top of the file:
 * { features: PROFILE, profile: { champion: [...] }, center: [...], items: { "<item>": [weights] } }
 * An item is worth items[i] · (Σ enemy profiles - center) in win chance; 0 against an
 * average enemy team.
 */
function analyzeSituations(matches, facts) {
  const profile = profiles(matches, facts);
  const zero = PROFILE.map(() => 0);
  const isItem = (id) => facts.completed.has(id) || facts.boots.has(id);
  const each = (fn) => {
    for (const m of matches) {
      if (!m.gb || !m.gr) continue;
      for (const [team, gear, enemy, won] of [[m.b, m.gb, m.r, m.w === 1], [m.r, m.gr, m.b, m.w === 0]]) {
        const T = enemy.reduce((t, e) => t.map((v, f) => v + (profile[e] || zero)[f]), zero);
        team.forEach((c, r) => {
          if (!gear[r]) return;
          const items = [...new Set(gear[r].slice(GEAR.items, GEAR.items + 6))].filter(isItem);
          fn({ key: `${c}:${r}`, items, T, win: won ? 1 : 0 });
        });
      }
    }
  };
  const add = (map, key, v) => {
    const x = map.get(key) || [0, 0];
    x[0] += v;
    x[1] += 1;
    map.set(key, x);
  };
  // Win rate per champion:role, and per champion:role:number of completed items
  const role = new Map();
  const cell = new Map();
  const center = zero.slice();
  let teams = 0;
  each((g) => {
    add(role, g.key, g.win);
    add(cell, `${g.key}:${g.items.length}`, g.win);
    g.T.forEach((v, f) => (center[f] += v));
    teams++;
  });
  for (let f = 0; f < center.length; f++) center[f] /= teams || 1;
  const k = PROFILE.length + 1;
  const resid = (g) => {
    const [rw, rn] = role.get(g.key);
    const [w, n] = cell.get(`${g.key}:${g.items.length}`);
    return g.win - (w + (CELL_PRIOR * rw) / rn) / (n + CELL_PRIOR);
  };
  const xOf = (g) => [1, ...g.T.map((v, f) => v - center[f])];
  const accumulate = (map, key, x, y) => {
    let e = map.get(key);
    if (!e) map.set(key, (e = { A: Array.from({ length: k }, () => new Array(k).fill(0)), b: new Array(k).fill(0), n: 0 }));
    for (let a = 0; a < k; a++) {
      e.b[a] += x[a] * y;
      for (let c = 0; c < k; c++) e.A[a][c] += x[a] * x[c];
    }
    e.n++;
  };
  const fit = (e) => {
    for (let a = 1; a < k; a++) e.A[a][a] += RIDGE;
    return solve(e.A, e.b);
  };
  // What the enemy profile does to everyone in a role
  const byRole = new Map();
  each((g) => accumulate(byRole, g.key.split(':')[1], xOf(g), resid(g)));
  const roleSlope = new Map([...byRole].map(([r, e]) => [r, fit(e).x]));
  // Per item: residual beyond that ~ intercept + (T - center), over its buyers' games
  const eq = new Map();
  each((g) => {
    if (!g.items.length) return;
    const x = xOf(g);
    const slope = roleSlope.get(g.key.split(':')[1]);
    const y = resid(g) - x.reduce((a, v, j) => a + (j ? v * slope[j] : 0), 0);
    for (const i of g.items) accumulate(eq, i, x, y);
  });
  const items = {};
  for (const [i, e] of eq) {
    if (e.n < SIT_MIN) continue;
    const { x, inv } = fit(e);
    // Results are 0/1 around one half: variance about 0.25
    const weights = x.slice(1).map((v, f) => (Math.abs(v) / Math.sqrt(0.25 * inv[f + 1]) >= Z_KEEP ? Math.round(v * 10000) / 10000 : 0));
    if (weights.some(Boolean)) items[i] = weights;
  }
  return { features: PROFILE, profile, center: center.map((v) => Math.round(v * 1000) / 1000), items };
}

function pickSpells(games) {
  return mode(games.map((g) => [g.gear[GEAR.spells], g.gear[GEAR.spells + 1]].sort((a, b) => a - b).join(':')))
    .split(':').map(Number);
}

/** Lower and upper third of teams' magic share: [low, high] */
function thresholds(matches, magic) {
  const shares = [];
  for (const m of matches) {
    if (!m.gb) continue;
    for (const t of [m.b, m.r]) shares.push(t.reduce((a, c) => a + (magic[c] ?? 0.5), 0) / 5);
  }
  if (!shares.length) return [0.35, 0.55];
  shares.sort((a, b) => a - b);
  return [shares[Math.floor(shares.length / 3)], shares[Math.floor((2 * shares.length) / 3)]];
}

/** 'ap', 'ad' or 'mixed' for an enemy team */
const bucketOf = (team, magic, [low, high]) => {
  const share = team.reduce((a, c) => a + (magic[c] ?? 0.5), 0) / team.length;
  return share >= high ? 'ap' : share <= low ? 'ad' : 'mixed';
};

/**
 * @param matches compact matches (those with gear count)
 * @param facts   loadDdragon() result
 * @returns { rows: [{ champion_id, role, bucket, games, runes, items, spells }], thresholds }
 */
function analyzeBuilds(matches, facts) {
  const ROLES = ['top', 'jungle', 'middle', 'bottom', 'utility'];
  const cut = thresholds(matches, facts.magic);
  const groups = new Map();
  const add = (key, g) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  };
  for (const m of matches) {
    if (!m.gb || !m.gr) continue;
    for (const [team, gear, enemy, won] of [[m.b, m.gb, m.r, m.w === 1], [m.r, m.gr, m.b, m.w === 0]]) {
      const bucket = bucketOf(enemy, facts.magic, cut);
      team.forEach((c, r) => {
        if (!gear[r]) return;
        const sets = team === m.b ? m.sb : m.sr;
        const g = { gear: gear[r], win: won ? 1 : 0, start: sets?.[r] || null };
        add(`${c}:${r}:any`, g);
        add(`${c}:${r}:${bucket}`, g);
      });
    }
  }
  const rows = [];
  for (const [key, games] of groups) {
    const [c, r, bucket] = key.split(':');
    if (games.length < (bucket === 'any' ? MIN_GAMES : BUCKET_MIN)) continue;
    const runes = pickRunes(games);
    if (!runes) continue;
    rows.push({
      champion_id: Number(c), role: ROLES[Number(r)], bucket, games: games.length,
      runes, items: pickItems(games, facts), spells: pickSpells(games),
    });
  }
  return { rows, thresholds: cut };
}

module.exports = { analyzeBuilds, analyzeSituations, profiles, loadDdragon, bucketOf, GEAR, PROFILE };
