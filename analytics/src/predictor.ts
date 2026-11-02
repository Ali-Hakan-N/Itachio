import * as ort from 'onnxruntime-node';
import { DRAFT_FEATURE_COUNT, DRAFT_FEATURE_NAMES, type DraftStateVector } from './features.js';

export type DraftResponse = {
  winProbability: number;
  top3Suggestions: Array<{ championId: number; contributionReason: string }>;
};

export interface FeatureAttribution {
  feature: string;
  contribution: number;
}

const BASELINE_RATE_FEATURES = new Set([0, 1, 2, 20]);
const finite = (value: number): number => Number.isFinite(value) ? value : 0;

export class DraftPredictor {
  private constructor(private readonly session: ort.InferenceSession, private readonly inputName: string, private readonly outputName: string, private readonly featureNames: readonly string[]) {}

  /** featureNames: the model's columns, for a model with more than the 58 draft features (hybrid.ts) */
  static async load(modelPath: string, featureNames: readonly string[] = DRAFT_FEATURE_NAMES): Promise<DraftPredictor> {
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    if (session.inputNames.length !== 1 || session.outputNames.length !== 1) {
      await session.release();
      throw new Error('Draft ONNX model must have exactly one input and one output');
    }
    return new DraftPredictor(session, session.inputNames[0]!, session.outputNames[0]!, featureNames);
  }

  async predictWinProbability(currentState: DraftStateVector): Promise<number> {
    return (await this.predictBatch([currentState.features]))[0]!;
  }

  async explain(currentState: DraftStateVector, steps = 10, epsilon = 1e-3): Promise<FeatureAttribution[]> {
    const featureCount = this.featureNames.length;
    if (currentState.features.length !== featureCount) throw new Error(`Expected ${featureCount} features`);
    if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error('steps must be an integer from 1 to 100');
    if (!(epsilon > 0) || epsilon > 0.1) throw new Error('epsilon must be in (0, 0.1]');
    const baseline = currentState.features.map((_, index) => BASELINE_RATE_FEATURES.has(index) ? 0.5 : 0);
    const delta = currentState.features.map((value, index) => finite(value) - baseline[index]!);
    const contributions = new Array<number>(featureCount).fill(0);

    for (let step = 0; step <= steps; step++) {
      const alpha = step / steps;
      const point = baseline.map((value, index) => value + alpha * delta[index]!);
      const batch = [point];
      for (let feature = 0; feature < featureCount; feature++) {
        const perturbed = [...point];
        perturbed[feature] = perturbed[feature]! + epsilon;
        batch.push(perturbed);
      }
      const predictions = await this.predictBatch(batch);
      const pathProbability = predictions[0]!;
      const integrationWeight = (step === 0 || step === steps ? 0.5 : 1) / steps;
      for (let feature = 0; feature < featureCount; feature++) {
        const gradient = (predictions[feature + 1]! - pathProbability) / epsilon;
        contributions[feature] = contributions[feature]! + delta[feature]! * gradient * integrationWeight;
      }
    }

    return contributions.map((contribution, index) => ({ feature: this.featureNames[index]!, contribution }))
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  }

  async recommend(candidates: readonly DraftStateVector[]): Promise<DraftResponse> {
    if (!candidates.length) return { winProbability: 0.5, top3Suggestions: [] };
    const probabilities = await this.predictBatch(candidates.map((candidate) => candidate.features));
    const ranked = candidates.map((candidate, index) => ({ candidate, probability: probabilities[index]! }))
      .sort((a, b) => b.probability - a.probability);
    const top3Suggestions = await Promise.all(ranked.slice(0, 3).map(async ({ candidate }) => {
      const attribution = await this.explain(candidate);
      const positive = attribution.find((entry) => entry.contribution > 0);
      const negative = attribution.find((entry) => entry.contribution < 0);
      const parts = [
        positive ? `helps: ${humanize(positive.feature)}` : '',
        negative ? `costs: ${humanize(negative.feature)}` : '',
      ].filter(Boolean);
      return { championId: candidate.champion_id, contributionReason: parts.join('; ') || 'No single feature dominates the estimate' };
    }));
    return { winProbability: ranked[0]!.probability, top3Suggestions };
  }

  async close(): Promise<void> {
    await this.session.release();
  }

  private async predictBatch(rows: readonly number[][]): Promise<number[]> {
    if (!rows.length) return [];
    const featureCount = this.featureNames.length;
    if (rows.some((row) => row.length !== featureCount)) throw new Error(`Each model input must contain ${featureCount} features`);
    const flattened = new Float32Array(rows.length * featureCount);
    rows.forEach((row, rowIndex) => row.forEach((value, column) => { flattened[rowIndex * featureCount + column] = finite(value); }));
    const tensor = new ort.Tensor('float32', flattened, [rows.length, featureCount]);
    const result = await this.session.run({ [this.inputName]: tensor });
    const output = result[this.outputName] as ort.Tensor;
    return Array.from(output.data as Float32Array, (probability) => Math.min(1, Math.max(0, probability)));
  }
}

function humanize(feature: string): string {
  return feature.replaceAll('_', ' ');
}