const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_OBSERVATIONS,
  prepareMetaSource,
  metaFeatures,
  makeOutOfTimeObservations,
  fitMetaCalibrator,
  calibratedMetaLogit,
  selectModelWeight,
} = require('../src/model/ensemble');

test('MetaSrc snapshots produce role strength, team synergy and directional matchup features', () => {
  const source = prepareMetaSource({
    data: {
      meta: [
        { champion_id: 1, role: 'top', score: 70 },
        { champion_id: 2, role: 'top', score: 50 },
        { champion_id: 3, role: 'jungle', score: 60 },
        { champion_id: 4, role: 'jungle', score: 50 },
      ],
      synergy: [{ champion_id: 1, role: 'top', ally_id: 3, strength: 0.4 }],
      matchup: [{ champion_id: 1, role: 'top', opponent_id: 2, opponent_role: 'top', strength: 0.3 }],
    },
  });
  const features = metaFeatures({ b: [1, 3, 5, 6, 7], r: [2, 4, 8, 9, 10] }, source);

  assert.ok(features[0] > 0);
  assert.equal(features[1], 0.4);
  assert.equal(features[2], 0.3);
});

test('MetaSrc calibration learns an out-of-time logit from prior match outcomes', () => {
  const rows = Array.from({ length: 600 }, (_, i) => {
    const feature = Math.sin(i * 1.71);
    return { features: [feature, 0, 0], win: feature > 0 };
  });
  const calibration = fitMetaCalibrator(rows);

  assert.ok(calibratedMetaLogit([1, 0, 0], calibration) > calibratedMetaLogit([-1, 0, 0], calibration));
});

test('ensemble weight stays on the confidence fallback until enough forward observations', () => {
  assert.deepEqual(selectModelWeight(Array(MIN_OBSERVATIONS - 1).fill({})), {
    supported: false,
    modelWeight: null,
    matches: MIN_OBSERVATIONS - 1,
    minimum: MIN_OBSERVATIONS,
  });
});

test('ensemble weight favors MetaSrc only when it significantly improves future logloss', () => {
  const observations = Array.from({ length: 1000 }, (_, i) => {
    const feature = Math.sin(i * 1.71);
    const win = feature > 0;
    return {
      startedAt: i,
      features: [feature, 0, 0],
      modelLogit: feature * 0.05,
      win,
    };
  });
  const selection = selectModelWeight(observations);

  assert.equal(selection.supported, true);
  assert.ok(selection.modelWeight < 0.5);
  assert.ok(selection.candidateLogloss < selection.baselineLogloss);
});

test('ensemble weight stays at 50% when the model wins the holdout comparison', () => {
  const observations = Array.from({ length: 1000 }, (_, i) => {
    const outcomeSignal = Math.sin(i * 1.71);
    const win = outcomeSignal > 0;
    return {
      startedAt: i,
      features: [Math.sin(i * 7.31), Math.cos(i * 3.17), Math.sin(i * 11.13)],
      modelLogit: win ? 4 : -4,
      win,
    };
  });
  const selection = selectModelWeight(observations);

  assert.equal(selection.supported, false);
  assert.equal(selection.modelWeight, 0.5);
});

test('out-of-time observations require both snapshots to predate the match', () => {
  const modelSnapshot = {
    id: 12,
    patch: '16.22',
    created_at: '2026-10-01T00:00:00.000Z',
    data: { champ: {}, off: [0, 0, 0, 0, 0], bias: 0 },
  };
  const sourceSnapshots = [
    { id: 20, patch: '16.22', collected_at: '2026-10-02T00:00:00.000Z', data: { meta: [], synergy: [], matchup: [] } },
    { id: 21, patch: '16.22', collected_at: '2026-10-04T00:00:00.000Z', data: { meta: [], synergy: [], matchup: [] } },
  ];
  const matches = [
    { id: 'X_1', patch: '16.22', t: Date.parse('2026-10-03T00:00:00.000Z'), w: 1, b: [1, 2, 3, 4, 5], r: [6, 7, 8, 9, 10] },
    { id: 'X_2', patch: '16.22', t: Date.parse('2026-10-01T12:00:00.000Z'), w: 1, b: [1, 2, 3, 4, 5], r: [6, 7, 8, 9, 10] },
  ];

  const rows = makeOutOfTimeObservations(matches, { modelSnapshot, sourceSnapshots, now: Date.parse('2026-10-05T00:00:00.000Z') });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].match_id, 'X_1');
  assert.equal(rows[0].source_snapshot_id, 20);
});