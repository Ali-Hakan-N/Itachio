const test = require('node:test');
const assert = require('node:assert/strict');
const { toRows, normalizeRole, championResolver } = require('../src/normalize');

const CHAMPS = [
  { id: 103, slug: 'Ahri', name: 'Ahri' },
  { id: 62, slug: 'MonkeyKing', name: 'Wukong' },
  { id: 20, slug: 'Nunu', name: 'Nunu & Willump' },
  { id: 238, slug: 'Zed', name: 'Zed' },
  { id: 145, slug: 'Kaisa', name: "Kai'Sa" },
];
const opts = { source: 'test', collectedAt: '2026-10-29T10:00:00.000Z' };

test('roles are recognized from different spellings', () => {
  assert.equal(normalizeRole('MID'), 'middle');
  assert.equal(normalizeRole('ADC'), 'bottom');
  assert.equal(normalizeRole('Support'), 'utility');
  assert.equal(normalizeRole('Jungle'), 'jungle');
  assert.equal(normalizeRole('lane'), null);
});

test('champions resolve from id, slug, display name and short name', () => {
  const r = championResolver(CHAMPS);
  assert.equal(r(103), 103);
  assert.equal(r('103'), 103);
  assert.equal(r('MonkeyKing'), 62);
  assert.equal(r('wukong'), 62);
  assert.equal(r('Nunu & Willump'), 20);
  assert.equal(r('nunu'), 20);
  assert.equal(r('kaisa'), 145);
  assert.equal(r('Teemo'), null);
  assert.equal(r(999), null);
});

test('valid rows convert; invalid ones are dropped and reported', () => {
  const rows = toRows(
    {
      patch: '16.21',
      meta: [
        { champion: 'Ahri', role: 'mid', score: 61.5, tier: 'A', win_rate: '51.2', games: '1200' },
        { champion: 'Ahri', role: 'middle', score: 70 }, // duplicate: the first one stays
        { champion: 'Zed', role: 'mid', score: 140 }, // out of range
        { champion: 'Teemo', role: 'top', score: 50 }, // unknown champion
        { champion: 'Wukong', role: 'river', score: 50 }, // unknown role
      ],
      synergy: [
        { champion: 'Ahri', role: 'mid', ally: 'Wukong', strength: 0.7, games: 300 },
        { champion: 'Ahri', role: 'mid', ally: 'Ahri', strength: 0.5 }, // with itself
      ],
      matchup: [
        { champion: 'Ahri', role: 'mid', opponent: 'Zed', strength: -0.4 },
        { champion: 'Ahri', role: 'mid', opponent: 'Zed', strength: 1.5 }, // duplicate
      ],
    },
    CHAMPS,
    opts,
  );
  assert.equal(rows.meta.length, 1);
  assert.deepEqual(
    { ...rows.meta[0] },
    {
      source: 'test', collected_at: opts.collectedAt, champion_id: 103, role: 'middle', patch: '16.21',
      score: 61.5, tier: 'A', win_rate: 51.2, pick_rate: null, ban_rate: null, games: 1200,
    },
  );
  assert.equal(rows.synergy.length, 1);
  assert.equal(rows.synergy[0].ally_id, 62);
  assert.equal(rows.matchup.length, 1);
  assert.equal(rows.matchup[0].strength, -0.4);
  assert.ok(rows.problems.some((p) => p.includes('Teemo')));
  assert.ok(rows.problems.some((p) => p.includes('river')));
  assert.ok(rows.problems.some((p) => p.includes('0-100')));
});
