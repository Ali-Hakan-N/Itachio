import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTrainingObservations, compactMatchToRiotMatch, isCompactMatch, type CompactMatch } from '../src/training-data.js';
import type { RiotMatchV5 } from '../src/clickhouse.js';

function makeMatch(id: number, blueWon: boolean): RiotMatchV5 {
  const positions = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
  const participants = positions.flatMap((position, index) => [
    { championId: index + 1, teamId: 100, teamPosition: position, win: blueWon, magicDamageDealtToChampions: 1000, physicalDamageDealtToChampions: 4000, totalDamageTaken: 8000, totalHeal: 2000, timeCCingOthers: 12 },
    { championId: index + 11, teamId: 200, teamPosition: position, win: !blueWon, magicDamageDealtToChampions: 4000, physicalDamageDealtToChampions: 1000, totalDamageTaken: 4000, totalHeal: 1000, timeCCingOthers: 6 },
  ]);
  return {
    metadata: { matchId: `EUW1_${id}` },
    info: {
      queueId: 440,
      gameVersion: '16.21.1',
      gameStartTimestamp: 1700000000000 + id * 1000,
      gameDuration: 1900,
      participants,
      teams: [{ teamId: 100, win: blueWon }, { teamId: 200, win: !blueWon }],
    },
  };
}

test('training observations use a prior history window and emit ten labeled rows per later match', () => {
  const matches = Array.from({ length: 20 }, (_, index) => makeMatch(index, index < 14));
  const rows = buildTrainingObservations(matches, { priorFraction: 0.7, minimumPriorMatches: 10 });
  assert.equal(rows.length, 60);
  assert.equal(rows[0]!.match_id, 'EUW1_14');
  assert.equal(rows[0]!.won, 0);
  assert.ok(rows.every((row) => row.features.length === 58));
});

test('a later match result does not leak into its own feature vector', () => {
  const matches = Array.from({ length: 20 }, (_, index) => makeMatch(index, index < 14));
  const flipped = matches.map((match, index) => index === 19 ? makeMatch(index, true) : match);
  const originalRows = buildTrainingObservations(matches, { priorFraction: 0.7, minimumPriorMatches: 10 });
  const flippedRows = buildTrainingObservations(flipped, { priorFraction: 0.7, minimumPriorMatches: 10 });
  assert.deepEqual(originalRows.at(-1)?.features, flippedRows.at(-1)?.features);
  assert.notEqual(originalRows.at(-1)?.won, flippedRows.at(-1)?.won);
});

test('stored Itachio compact matches map into the typed Match-V5 training shape', () => {
  const compact: CompactMatch = {
    id: 'EUW1_55', q: 440, w: 1, b: [1, 2, 3, 4, 5], r: [6, 7, 8, 9, 10], patch: '16.21', t: 1700000000000,
    xb: [[100, 200, 30, 12], null, null, null, null],
  };
  assert.equal(isCompactMatch(compact), true);
  const match = compactMatchToRiotMatch(compact);
  assert.equal(match.metadata.matchId, 'EUW1_55');
  assert.equal(match.info.participants[0]!.teamPosition, 'TOP');
  assert.equal(match.info.participants[0]!.timeCCingOthers, 12);
  assert.equal(match.info.participants[5]!.teamId, 200);
  assert.equal(match.info.participants[5]!.win, false);
});

test('invalid historical compact rows are rejected rather than assigned a fake patch', () => {
  const row: CompactMatch = { id: 'EUW1_old', q: 440, w: 1, b: [1, 2, 3, 4, 5], r: [6, 7, 8, 9, 10] };
  assert.equal(isCompactMatch(row), false);
  assert.equal(isCompactMatch(row, '16.21'), true);
  assert.equal(compactMatchToRiotMatch(row, '16.21').info.gameVersion, '16.21.1');
});