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

const DDRAGON = 'https://ddragon.leagueoflegends.com/cdn';

/** Item and champion facts from Data Dragon: completed items, boots, magic share per champion */
async function loadDdragon(version, fetchFn = globalThis.fetch) {
  const get = async (file) => {
    const res = await fetchFn(`${DDRAGON}/${version}/data/en_US/${file}`);
    if (!res.ok) throw new Error(`Data Dragon ${file}: HTTP ${res.status}`);
    return res.json();
  };
  const [items, champions] = await Promise.all([get('item.json'), get('champion.json')]);
  const completed = new Set();
  const boots = new Set();
  for (const [id, it] of Object.entries(items.data)) {
    if (!it.maps?.['11'] || it.tags?.includes('Consumable') || it.tags?.includes('Trinket')) continue;
    if (it.tags?.includes('Boots') && (it.depth || 1) >= 2) boots.add(Number(id));
    // Final items, including ones that are not bought but transformed into (Muramana)
    else if (!(it.into || []).length && it.gold.total >= 1600) completed.add(Number(id));
  }
  const magic = {};
  for (const c of Object.values(champions.data)) {
    const { attack = 0, magic: m = 0 } = c.info || {};
    magic[Number(c.key)] = attack + m ? m / (attack + m) : 0.5;
  }
  return { completed, boots, magic };
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

function pickItems(games, { completed, boots }) {
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
  return { core: ranked.slice(0, CORE), more: ranked.slice(CORE, CORE + MORE), boots: topBoots ? topBoots[0] : null };
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
        const g = { gear: gear[r], win: won ? 1 : 0 };
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

module.exports = { analyzeBuilds, loadDdragon, bucketOf, GEAR };
