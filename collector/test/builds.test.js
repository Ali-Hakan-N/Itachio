const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeBuilds, bucketOf } = require('../src/model/builds');

// gear: primary, keystone, 3 runes, sub, 2 runes, 3 shards, 6 items, 2 spells
const gear = (keystone, items, spells = [4, 14]) => [8000, keystone, 9111, 9104, 8014, 8300, 8345, 8304, 5005, 5008, 5001, ...items, ...spells];
const facts = { completed: new Set([3031, 3072, 3036, 6672]), boots: new Set([3006]), magic: { 1: 0, 2: 1, 3: 0, 4: 0.5 } };

function matches(n, pickGear) {
  return Array.from({ length: n }, (_, i) => {
    const g = pickGear(i);
    return { w: g.win, b: [1, 4, 4, 4, 4], r: [i % 2 ? 2 : 3, 4, 4, 4, 4], gb: [g.gear, null, null, null, null], gr: [null, null, null, null, null] };
  });
}

test('builds: a common keystone beats a rare one that won a few games; items by popularity', () => {
  // Keystone 8010 in 180 games at 50%; 8008 in 20 games, all won
  const ms = matches(200, (i) => (i < 20
    ? { gear: gear(8008, [3031, 3036, 0, 0, 0, 0]), win: 1 }
    : { gear: gear(8010, [3031, 3072, 3006, 0, 0, 0]), win: i % 2 }));
  const { rows } = analyzeBuilds(ms, facts);
  const any = rows.find((r) => r.champion_id === 1 && r.role === 'top' && r.bucket === 'any');
  assert.equal(any.runes.perks[0], 8010);
  assert.equal(any.runes.perks.length, 9);
  assert.deepEqual(any.items.core.slice(0, 2), [3031, 3072]);
  assert.equal(any.items.boots, 3006);
  assert.deepEqual(any.spells, [4, 14]);
});

test('builds: the most used keystone stays unless another wins clearly more; items in purchase order', () => {
  const ms = matches(400, (i) => (i < 100
    ? { gear: gear(8008, [3031, 3072, 0, 0, 0, 0]), win: i % 20 === 0 ? 0 : 1 }
    : { gear: gear(8010, [3072, 3031, 0, 0, 0, 0]), win: i % 2 }));
  ms.forEach((m) => (m.ob = [[3031, 3072], null, null, null, null]));
  const { rows } = analyzeBuilds(ms, facts);
  const any = rows.find((r) => r.champion_id === 1 && r.bucket === 'any');
  assert.equal(any.runes.perks[0], 8008, 'a keystone winning 95% vs 50% over 100 games is clearly better');
  assert.deepEqual(any.items.core, [3031, 3072]);
  const close = matches(400, (i) => ({ gear: gear(i < 100 ? 8008 : 8010, [3072, 3031, 0, 0, 0, 0]), win: i < 100 ? (i % 2 ? 1 : 0) : (i % 10 < 4 ? 1 : 0) }));
  assert.equal(analyzeBuilds(close, facts).rows.find((r) => r.bucket === 'any').runes.perks[0], 8010);
});

test('metasrc builds: widgets become runes, spells, starting items, items and a path', () => {
  const { parseBuild } = require('../src/sources/metasrc-builds');
  const img = (alt, file) => `I:${alt}|${file}`;
  const e = parseBuild({
    runes: ['T:Win %', 'T:Pick %', img('Lethal Tempo', 'runes/lethal-tempo-8008.png'), img('Inspiration', 'keystones/inspiration-8300.png'), 'T:52%', 'T:71%',
      img('Conqueror', 'runes/conqueror-8010.png'), img('Inspiration', 'keystones/inspiration-8300.png'), 'T:52%', 'T:16%'],
    spells: [img('Flash', 'spells/SummonerFlash.png'), img('Barrier', 'spells/SummonerBarrier.png'), 'T:52%', 'T:78%', img('Exhaust', 'spells/SummonerExhaust.png'), 'T:54%', 'T:10%'],
    start: [img("Doran's Bow", 'items/dorans-bow-1086.png'), img('Health Potion', 'items/health-potion-2003.png'), 'T:2', 'T:52%', 'T:78%', img('Stealth Ward', 'items/stealth-ward-3340.png'), 'T:52%', 'T:44%'],
    items: ['T:Core', img('A', 'items/a-3032.png'), img('Boots', 'items/b-3006.png'), 'T:53%', 'T:76%', img('LDR', 'items/ldr-3036.png'), 'T:62%', 'T:47%'],
    slots: [[img('GA', 'items/ga-3026.png'), 'T:63%', 'T:36%']],
    boots: [img('Berserker', 'items/berserkers-3006.png'), 'T:51%', 'T:76%'],
    path: [img("Doran's Bow", 'items/dorans-bow-1086.png'), img('Long Sword', 'items/ls-1036.png'), img('A', 'items/a-3032.png'), img('gold coin', 'icons/coin.png'), 'T:3000',
      img('Dagger', 'items/dagger-1042.png'), img('Boots', 'items/b-3006.png'), img('gold coin', 'icons/coin.png')],
  });
  assert.deepEqual(e.runes[1], { keystone: 8010, sub: 8300, pick: 0.16 });
  assert.deepEqual(e.spells.map((s) => s.ids), [[4, 21], [4, 3]]);
  assert.deepEqual(e.start[0].items, [1086, 2003, 2003]);
  assert.equal(e.items.find((i) => i.id === 3026).buy, 0.36);
  assert.deepEqual(e.path, [{ id: 3032, parts: [1036] }, { id: 3006, parts: [1042] }]);
});

test('builds: MetaSRC counts for its weight in spells and starting items; path in buying order', () => {
  const ms = matches(200, (i) => ({ gear: gear(8008, [3031, 3072, 0, 0, 0, 0], [4, 14]), win: i % 2 }));
  ms.forEach((m) => (m.ob = [[1036, 3072, 3031], null, null, null, null]));
  const meta = {
    weight: 0.8,
    builds: { '1:top': {
      runes: [{ keystone: 8010, sub: 8300, pick: 0.9 }, { keystone: 8008, sub: 8300, pick: 0.1 }],
      spells: [{ ids: [4, 3], pick: 0.9 }],
      start: [{ items: [1055, 2003], pick: 1 }],
      items: [{ id: 3031, buy: 0.9 }, { id: 3072, buy: 0.5 }],
      boots: [],
      path: [{ id: 3031, parts: [1038] }, { id: 3072, parts: [1053] }],
    } },
  };
  const f = { ...facts, shop: new Set([1055, 2003]) };
  const any = analyzeBuilds(ms, f, meta).rows.find((r) => r.champion_id === 1 && r.bucket === 'any');
  assert.equal(any.runes.perks[0], 8008, 'MetaSRC prefers 8010 but there are no games here to build its page from');
  assert.deepEqual(any.spells, [3, 4]);
  assert.deepEqual(any.items.start, [1055, 2003]);
  assert.deepEqual(any.items.path.map((s) => s.id), [3031, 3072]);
  assert.deepEqual(any.items.path.map((s) => s.parts), [[1038], [1053]]);
});

test('builds: components bought before each finished item, from the purchases in order', () => {
  const tree = new Map([[3031, new Set([1038, 1037])], [3006, new Set([1001, 1042])]]);
  const ms = matches(40, () => ({ gear: gear(8008, [3031, 0, 0, 0, 0, 0]), win: 1 }));
  ms.forEach((m) => (m.ob = [[1038, 2003, 1037, 3031], null, null, null, null]));
  const any = analyzeBuilds(ms, { ...facts, tree }).rows.find((r) => r.bucket === 'any');
  assert.deepEqual(any.items.path, [{ id: 3031, parts: [1038, 1037] }]);
});

test('builds: enemy damage buckets by magic share', () => {
  const magic = { 1: 0, 2: 1 };
  assert.equal(bucketOf([2, 2, 2, 2, 2], magic, [0.3, 0.6]), 'ap');
  assert.equal(bucketOf([1, 1, 1, 1, 1], magic, [0.3, 0.6]), 'ad');
  assert.equal(bucketOf([1, 1, 1, 2, 2], magic, [0.3, 0.6]), 'mixed');
});

test('situational items: an item whose buyers win more against magic damage learns it from the enemy profile', () => {
  const { analyzeSituations, profiles } = require('../src/model/builds');
  // Champion 1 top ends with item 3036 or 3072 (same item count). Against an all-magic
  // team (champion 2) the 3036 buyers win 3 games in 4; otherwise everyone wins half.
  const ms = Array.from({ length: 2400 }, (_, i) => {
    const buys = i % 2 === 0;
    const enemy = Math.floor(i / 2) % 2 === 0 ? 2 : 3;
    const win = buys && enemy === 2 ? (i % 16 !== 0 ? 1 : 0) : Math.floor(i / 4) % 2;
    const g = gear(8010, [3031, buys ? 3036 : 3072, 0, 0, 0, 0]);
    return { w: win, b: [1, 4, 4, 4, 4], r: [enemy, enemy, enemy, enemy, enemy], gb: [g, null, null, null, null], gr: [null, null, null, null, null] };
  });
  const sit = analyzeSituations(ms, facts);
  assert.deepEqual(sit.features, ['magic', 'heal', 'cc', 'assassin']);
  assert.ok(sit.profile[2][0] > sit.profile[3][0], 'champion 2 deals more magic damage');
  assert.ok(sit.items[3036][0] > 0, `3036 magic weight ${sit.items[3036]?.[0]}`);
  assert.ok(!sit.items[3072] || sit.items[3072][0] < sit.items[3036][0]);
  // Profiles are measured from players' numbers once there are enough games
  const measured = Array.from({ length: 30 }, () => ({
    b: [1, 4, 4, 4, 4], r: [2, 3, 3, 3, 3], d: 1800,
    xb: [[0, 1000, 9000, 5], null, null, null, null], xr: [[100, 0, 0, 60], null, null, null, null],
  }));
  const prof = profiles(measured, facts);
  assert.ok(prof[1][1] > prof[2][1], 'champion 1 heals');
  assert.ok(prof[2][2] > prof[1][2], 'champion 2 locks down');
});

test('builds: starting items from the games read with a timeline; item pool of real choices', () => {
  const ms = matches(60, (i) => ({ gear: gear(8010, [3031, i < 30 ? 3072 : 6672, 0, 0, 0, 0]), win: i % 2 }));
  ms.forEach((m, i) => (m.sb = [i % 3 ? [1055, 2003] : [1054, 2003], null, null, null, null]));
  const { rows } = analyzeBuilds(ms, { ...facts, shop: new Set([1054, 1055, 2003]) });
  const any = rows.find((r) => r.champion_id === 1 && r.bucket === 'any');
  assert.deepEqual(any.items.start, [1055, 2003]);
  assert.deepEqual([...any.items.pool].sort(), [3031, 3072, 6672]);
});

test('starting items: purchases of the first minute, minus undone ones', () => {
  const { startingItems } = require('../src/riot/parse');
  const ev = (type, participantId, timestamp, extra) => ({ type, participantId, timestamp, ...extra });
  const timeline = { info: { frames: [{ events: [
    ev('ITEM_PURCHASED', 1, 1000, { itemId: 1055 }),
    ev('ITEM_PURCHASED', 1, 2000, { itemId: 1054 }),
    ev('ITEM_UNDO', 1, 3000, { beforeId: 1054, afterId: 0 }),
    ev('ITEM_PURCHASED', 1, 4000, { itemId: 2003 }),
    ev('ITEM_PURCHASED', 2, 1000, { itemId: 1056 }),
  ] }, { events: [ev('ITEM_PURCHASED', 1, 300000, { itemId: 3006 })] }] } };
  const s = startingItems(timeline);
  assert.deepEqual(s.get(1), [1055, 2003]);
  assert.deepEqual(s.get(2), [1056]);
});

test('build data: a stored match gets its starting items by participant id', () => {
  const { startsOf } = require('../src/riot/timelines');
  const m = { id: 'TR1_1', ib: [1, 2, 3, 4, 5], ir: [6, 7, 8, 9, 10] };
  const timeline = { info: { frames: [{ events: [
    { type: 'ITEM_PURCHASED', participantId: 2, timestamp: 1000, itemId: 1039 },
    { type: 'ITEM_PURCHASED', participantId: 9, timestamp: 1000, itemId: 1055 },
  ] }] } };
  const row = startsOf(m, timeline);
  assert.deepEqual(row.sb, [null, [1039], null, null, null]);
  assert.deepEqual(row.sr, [null, null, null, [1055], null]);
});
