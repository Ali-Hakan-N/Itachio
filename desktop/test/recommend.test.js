const test = require('node:test');
const assert = require('node:assert/strict');
const { recommend, SYNERGY_MAX, MATCHUP_MAX } = require('../src/renderer/recommend');

// 1 Ahri, 2 Zed, 3 Syndra, 4 Lee Sin, 5 Yasuo, 6 Leona
const stats = {
  meta: [
    { champion_id: 1, role: 'middle', score: 60 },
    { champion_id: 2, role: 'middle', score: 58 },
    { champion_id: 3, role: 'middle', score: 55 },
    { champion_id: 4, role: 'jungle', score: 62 },
    { champion_id: 5, role: 'middle', score: 50 },
    { champion_id: 5, role: 'top', score: 52 },
    { champion_id: 6, role: 'utility', score: 57 },
  ],
  synergy: [
    { champion_id: 3, role: 'middle', ally_id: 4, strength: 0.9 },
    { champion_id: 3, role: 'middle', ally_id: 6, strength: 0.6 },
  ],
  matchup: [
    { champion_id: 1, role: 'middle', opponent_id: 2, strength: -0.8 },
    { champion_id: 3, role: 'middle', opponent_id: 2, strength: 0.5 },
  ],
};

test('returns an empty list without data', () => {
  assert.deepEqual(recommend({ stats: { meta: [] }, role: 'middle' }), []);
});

test('without allies or enemies the order is the meta score', () => {
  const r = recommend({ stats, role: 'middle' });
  assert.deepEqual(r.map((x) => x.championId), [1, 2, 3, 5]);
  assert.equal(r[0].score, 60);
  assert.equal(r[0].synergy, 0);
});

test('a synergistic ally raises the score within the cap', () => {
  const [syndra] = recommend({ stats, role: 'middle', allies: [4, 6] }).filter((x) => x.championId === 3);
  assert.ok(syndra.score > 55);
  assert.ok(syndra.synergy <= SYNERGY_MAX);
  assert.deepEqual(syndra.allies.map((a) => a.championId), [4, 6]);
});

test('enemy matchups work both ways', () => {
  const r = recommend({ stats, role: 'middle', enemies: [{ championId: 2, position: 'middle' }] });
  const ahri = r.find((x) => x.championId === 1);
  const syndra = r.find((x) => x.championId === 3);
  assert.ok(ahri.matchup < 0 && ahri.score < 60);
  assert.ok(syndra.matchup > 0 && syndra.score > 55);
  assert.ok(Math.abs(ahri.matchup) <= MATCHUP_MAX);
  assert.equal(r[0].championId, 3); // Syndra moves ahead against Zed
});

test('reverse data: the enemy being weak against us is our strength', () => {
  // No direct row for Zed vs Ahri; Ahri's -0.8 vs Zed is read in reverse
  const zed = recommend({ stats, role: 'middle', enemies: [{ championId: 1 }] }).find((x) => x.championId === 2);
  assert.ok(zed.matchup > 0);
});

test('an enemy outside the lane matters less', () => {
  const lane = recommend({ stats, role: 'middle', enemies: [{ championId: 2, position: 'middle' }] }).find((x) => x.championId === 1);
  const other = recommend({ stats, role: 'middle', enemies: [{ championId: 2, position: 'jungle' }] }).find((x) => x.championId === 1);
  assert.ok(Math.abs(lane.matchup) > Math.abs(other.matchup));
});

test('stronger synergy gives more points', () => {
  const weak = { ...stats, synergy: [{ champion_id: 3, role: 'middle', ally_id: 4, strength: 0.2 }] };
  const strong = { ...stats, synergy: [{ champion_id: 3, role: 'middle', ally_id: 4, strength: 0.9 }] };
  const a = recommend({ stats: weak, role: 'middle', allies: [4] }).find((x) => x.championId === 3);
  const b = recommend({ stats: strong, role: 'middle', allies: [4] }).find((x) => x.championId === 3);
  assert.ok(a.synergy < b.synergy);
});

test('banned, picked and unpickable champions are removed; pool is marked', () => {
  const r = recommend({ stats, role: 'middle', unavailable: new Set([1]), pickable: [1, 2, 3], pool: [3] });
  assert.deepEqual(r.map((x) => x.championId), [2, 3]);
  assert.equal(r.find((x) => x.championId === 3).inPool, true);
});

test('without a role each champion is suggested in its best role', () => {
  const r = recommend({ stats });
  assert.equal(r.find((x) => x.championId === 5).role, 'top');
  assert.equal(r[0].championId, 4);
});

test('evaluate scores one champion with the current picks', () => {
  const r = require('../src/renderer/recommend').evaluate({
    stats, championId: 3, role: 'middle', allies: [4, 3], enemies: [{ championId: 2, position: 'middle' }],
  });
  assert.equal(r.base, 55);
  assert.ok(r.synergy > 0 && r.matchup > 0);
  assert.deepEqual(r.allies.map((a) => a.championId), [4]); // itself is ignored
});

test('evaluate falls back to the best role and returns null without data', () => {
  const { evaluate } = require('../src/renderer/recommend');
  assert.equal(evaluate({ stats, championId: 5, role: 'jungle' }).role, 'top');
  assert.equal(evaluate({ stats, championId: 99, role: 'middle' }), null);
});
