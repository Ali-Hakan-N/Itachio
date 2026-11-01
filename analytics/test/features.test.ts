import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDraftStateVector, DRAFT_FEATURE_COUNT, DRAFT_FEATURE_NAMES, validateDraftStateVector } from '../src/features.js';

const profile = (championId: number, winRate: number) => ({
  games: 200,
  wins: Math.round(200 * winRate),
  winRate,
  patchWinRate: winRate,
  laneWinRate: winRate,
  roleShare: 1,
  pickRate: 0.1,
  banRate: 0.02,
  uncertainty: 0.1,
  blindSpread: 0.03,
  counterRate: 0.05,
  counterChance: 0.3,
  scaling: 0.5,
  damage: championId === 1 ? [0.7, 0.2, 0.1] as const : [0.2, 0.7, 0.1] as const,
  cc: 2,
  frontline: 0.4,
  sustain: 0.3,
  range: 0.6,
  engage: 0.5,
});

test('draft schema contains 58 stable feature names', () => {
  assert.equal(DRAFT_FEATURE_COUNT, 58);
  assert.equal(DRAFT_FEATURE_NAMES.length, 58);
  assert.equal(new Set(DRAFT_FEATURE_NAMES).size, 58);
});

test('draft feature rows preserve the ClickHouse contract with finite defaults', () => {
  const row = buildDraftStateVector({
    championId: 1,
    teamSide: 'blue',
    laneId: 'TOP',
    allies: [{ championId: 2, laneId: 'JNG' }],
    enemies: [{ championId: 3, laneId: 'TOP' }],
    history: {
      champions: { '1:TOP': profile(1, 0.53), '2:JNG': profile(2, 0.51), '3:TOP': profile(3, 0.49) },
      matchups: { '1:TOP:3:TOP': { games: 50, wins: 29 } },
      synergies: { '1:TOP:2:JNG': { games: 40, wins: 22 } },
    },
    queueId: 440,
    rankTier: 3,
    pickOrder: 4,
    enemyAnswerShare: 0.5,
    patchAge: 2,
  }, { matchId: 'EUW1_123', patch: '16.21', won: 1 });
  validateDraftStateVector(row);
  assert.equal(row.features.length, 58);
  assert.equal(row.team_side, 'blue');
  assert.equal(row.lane_id, 'TOP');
  assert.equal(row.damage_profile.length, 3);
  assert.ok(row.matchup_winrate > 0.5);
  assert.ok(row.synergy_score > 0);
});

test('missing history produces a finite neutral feature vector', () => {
  const row = buildDraftStateVector({
    championId: 1,
    teamSide: 'red',
    laneId: 'MID',
    allies: [],
    enemies: [],
    history: { champions: {}, matchups: {}, synergies: {} },
    queueId: 420,
    rankTier: 0,
    pickOrder: 0,
    enemyAnswerShare: 1,
    patchAge: 0,
  }, { matchId: 'NA1_123', patch: '16.21', won: 0 });
  validateDraftStateVector(row);
  assert.equal(row.base_winrate, 0.5);
  assert.equal(row.matchup_winrate, 0.5);
  assert.ok(row.features.every(Number.isFinite));
});