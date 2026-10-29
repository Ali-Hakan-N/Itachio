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

test('builds: enemy damage buckets by magic share', () => {
  const magic = { 1: 0, 2: 1 };
  assert.equal(bucketOf([2, 2, 2, 2, 2], magic, [0.3, 0.6]), 'ap');
  assert.equal(bucketOf([1, 1, 1, 1, 1], magic, [0.3, 0.6]), 'ad');
  assert.equal(bucketOf([1, 1, 1, 2, 2], magic, [0.3, 0.6]), 'mixed');
});
