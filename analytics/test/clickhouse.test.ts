import assert from 'node:assert/strict';
import test from 'node:test';
import { toMatchInsertRow, type RiotMatchV5 } from '../src/clickhouse.js';

const match: RiotMatchV5 = {
  metadata: { matchId: 'EUW1_123' },
  info: {
    queueId: 440,
    gameVersion: '16.21.712.5555',
    gameStartTimestamp: 1790000000000,
    gameDuration: 1800,
    teams: [
      { teamId: 100, win: true, bans: [{ championId: 1 }] },
      { teamId: 200, win: false, bans: [{ championId: 2 }] },
    ],
    participants: [{
      championId: 1,
      teamId: 100,
      teamPosition: 'TOP',
      win: true,
      kills: 4,
      goldEarned: 12000,
      magicDamageDealtToChampions: 1000,
      physicalDamageDealtToChampions: 4000,
      trueDamageDealtToChampions: 100,
      timeCCingOthers: 12,
      visionWardsBoughtInGame: 3,
      item0: 1001,
    }],
  },
};

test('Match-V5 insert mapping preserves analytics facts without storing player identifiers', () => {
  const row = toMatchInsertRow(match, { region: 'euw1', rankTier: 'emerald' });
  assert.equal(row.patch, '16.21');
  assert.equal(row.rank_tier, 'EMERALD');
  assert.deepEqual(row.bans, [1, 2]);
  const participant = JSON.parse(row.participants_json)[0];
  assert.equal(participant.champion_id, 1);
  assert.equal(participant.lane_id, 'TOP');
  assert.equal(participant.cc_seconds, 12);
  assert.equal(participant.control_wards, 3);
  assert.equal('puuid' in participant, false);
});

test('Match-V5 insert mapping rejects payloads without a valid patch', () => {
  assert.throws(() => toMatchInsertRow({ ...match, info: { ...match.info, gameVersion: 'unknown' } }, { region: 'euw1' }), /Invalid Riot gameVersion/);
});