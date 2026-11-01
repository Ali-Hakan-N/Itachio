import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DRAFT_FEATURE_COUNT, DRAFT_FEATURE_NAMES, type DraftStateVector } from '../src/features.js';
import { DraftPredictor } from '../src/predictor.js';
import { exportDraftModelOnnx, splitDraftRowsByMatch, trainDraftModel } from '../src/training.js';

function row(championId: number, strength: number, won: 0 | 1): DraftStateVector {
  const features = new Array<number>(DRAFT_FEATURE_COUNT).fill(0);
  features[0] = strength;
  features[1] = strength;
  features[2] = strength;
  features[20] = strength;
  return {
    match_id: `test-${championId}-${strength}`,
    champion_id: championId,
    team_side: 'blue',
    lane_id: 'TOP',
    base_winrate: strength,
    matchup_winrate: strength,
    synergy_score: 0,
    damage_profile: [0.4, 0.5, 0.1],
    cc_score: 0,
    features,
    won,
    patch: '16.21',
    queue_id: 440,
    rank_tier: 'EMERALD',
  };
}

test('logistic trainer exports a loadable ONNX model with stable feature order', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => {
    const rate = (index % 10) / 9;
    return row(index + 1, rate, rate > 0.5 ? 1 : 0);
  });
  const model = trainDraftModel(rows, { minimumExamples: 20, epochs: 80, learningRate: 0.3 });
  assert.deepEqual(model.featureNames, DRAFT_FEATURE_NAMES);
  assert.equal(model.featureCount, DRAFT_FEATURE_COUNT);

  const directory = await mkdtemp(join(tmpdir(), 'itachio-onnx-'));
  const modelPath = join(directory, 'draft.onnx');
  await exportDraftModelOnnx(model, modelPath);
  const predictor = await DraftPredictor.load(modelPath);
  try {
    const low = row(1, 0.1, 0);
    const high = row(2, 0.9, 1);
    const lowProbability = await predictor.predictWinProbability(low);
    const highProbability = await predictor.predictWinProbability(high);
    assert.ok(highProbability > lowProbability);

    const attributions = await predictor.explain(high);
    const sum = attributions.reduce((total, entry) => total + entry.contribution, 0);
    const baseline = row(3, 0.5, 0);
    const baselineProbability = await predictor.predictWinProbability(baseline);
    const completenessError = sum - (highProbability - baselineProbability);
    assert.ok(Math.abs(completenessError) < 0.03, `IG completeness error: ${completenessError}`);
    assert.equal(attributions.length, DRAFT_FEATURE_COUNT);

    const response = await predictor.recommend([low, high, row(4, 0.7, 1)]);
    assert.equal(response.top3Suggestions.length, 3);
    assert.equal(response.top3Suggestions[0]!.championId, 2);
  } finally {
    await predictor.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('validation split keeps every role row from one match on the same side', () => {
  const rows = Array.from({ length: 10 }, (_, match) =>
    Array.from({ length: 10 }, (_, role) => ({ ...row(role + 1, match / 9, (match % 2) as 0 | 1), match_id: `match-${match}` })),
  ).flat();
  const split = splitDraftRowsByMatch(rows);
  const trainingMatches = new Set(split.trainRows.map((entry) => entry.match_id));
  const validationMatches = new Set(split.validationRows.map((entry) => entry.match_id));
  assert.equal(split.trainRows.length, 80);
  assert.equal(split.validationRows.length, 20);
  assert.equal([...trainingMatches].some((id) => validationMatches.has(id)), false);
});