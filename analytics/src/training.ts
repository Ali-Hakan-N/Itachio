import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { DRAFT_FEATURE_COUNT, DRAFT_FEATURE_NAMES, validateDraftStateVector, type DraftStateVector } from './features.js';

const { onnx } = createRequire(import.meta.url)('onnx-proto') as { onnx: typeof import('onnx-proto').onnx };

export interface LogisticModel {
  version: 1;
  featureCount: 58;
  featureNames: readonly string[];
  mean: number[];
  scale: number[];
  weights: number[];
  bias: number;
  trainedAt: string;
  examples: number;
  validationLogLoss: number;
  validationAccuracy: number;
}

export interface TrainOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
  minimumExamples?: number;
}

export function splitDraftRowsByMatch(rows: readonly DraftStateVector[], trainFraction = 0.8) {
  if (!(trainFraction > 0 && trainFraction < 1)) throw new Error('trainFraction must be between 0 and 1');
  const matchIds = [...new Set(rows.map((row) => row.match_id))];
  if (matchIds.length < 2) throw new Error('At least two distinct matches are required for a validation split');
  const splitAt = Math.max(1, Math.min(matchIds.length - 1, Math.floor(matchIds.length * trainFraction)));
  const trainingMatches = new Set(matchIds.slice(0, splitAt));
  return {
    trainRows: rows.filter((row) => trainingMatches.has(row.match_id)),
    validationRows: rows.filter((row) => !trainingMatches.has(row.match_id)),
  };
}

const sigmoid = (value: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
const logLoss = (label: number, probability: number): number =>
  -(label * Math.log(Math.max(probability, 1e-7)) + (1 - label) * Math.log(Math.max(1 - probability, 1e-7)));

function prepare(rows: readonly DraftStateVector[]) {
  const mean = new Array<number>(DRAFT_FEATURE_COUNT).fill(0);
  const scale = new Array<number>(DRAFT_FEATURE_COUNT).fill(0);
  for (const row of rows) for (let i = 0; i < DRAFT_FEATURE_COUNT; i++) mean[i] = mean[i]! + row.features[i]! / rows.length;
  for (const row of rows) for (let i = 0; i < DRAFT_FEATURE_COUNT; i++) scale[i] = scale[i]! + ((row.features[i]! - mean[i]!) ** 2) / rows.length;
  for (let i = 0; i < DRAFT_FEATURE_COUNT; i++) scale[i] = Math.sqrt(scale[i]!) || 1;
  return { mean, scale };
}

function fit(rows: readonly DraftStateVector[], epochs: number, learningRate: number, l2: number) {
  const { mean, scale } = prepare(rows);
  const weights = new Array<number>(DRAFT_FEATURE_COUNT).fill(0);
  let bias = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = new Array<number>(DRAFT_FEATURE_COUNT).fill(0);
    let biasGradient = 0;
    for (const row of rows) {
      let logit = bias;
      for (let i = 0; i < DRAFT_FEATURE_COUNT; i++) logit += weights[i]! * ((row.features[i]! - mean[i]!) / scale[i]!);
      const error = sigmoid(logit) - row.won;
      biasGradient += error;
      for (let i = 0; i < DRAFT_FEATURE_COUNT; i++) gradient[i] = gradient[i]! + error * ((row.features[i]! - mean[i]!) / scale[i]!);
    }
    const step = learningRate / rows.length;
    bias -= step * biasGradient;
    for (let i = 0; i < DRAFT_FEATURE_COUNT; i++) weights[i] = weights[i]! - step * (gradient[i]! + l2 * weights[i]!);
  }
  return { mean, scale, weights, bias };
}

function score(row: DraftStateVector, params: ReturnType<typeof fit>): number {
  let logit = params.bias;
  for (let i = 0; i < DRAFT_FEATURE_COUNT; i++) logit += params.weights[i]! * ((row.features[i]! - params.mean[i]!) / params.scale[i]!);
  return sigmoid(logit);
}

export function trainDraftModel(rows: readonly DraftStateVector[], options: TrainOptions = {}): LogisticModel {
  const minimumExamples = options.minimumExamples ?? 1000;
  if (rows.length < minimumExamples) throw new Error(`Need at least ${minimumExamples} draft observations; received ${rows.length}`);
  for (const row of rows) validateDraftStateVector(row);
  const { trainRows, validationRows } = splitDraftRowsByMatch(rows);
  const epochs = options.epochs ?? 60;
  const learningRate = options.learningRate ?? 0.2;
  const l2 = options.l2 ?? 0.01;
  const validationFit = fit(trainRows, epochs, learningRate, l2);
  const validationProbabilities = validationRows.map((row) => score(row, validationFit));
  const validationLogLoss = validationRows.reduce((sum, row, i) => sum + logLoss(row.won, validationProbabilities[i]!), 0) / validationRows.length;
  const validationAccuracy = validationRows.reduce((sum, row, i) => sum + (Number(validationProbabilities[i]! >= 0.5) === row.won ? 1 : 0), 0) / validationRows.length;
  const finalFit = fit(rows, epochs, learningRate, l2);
  return {
    version: 1,
    featureCount: DRAFT_FEATURE_COUNT,
    featureNames: [...DRAFT_FEATURE_NAMES],
    ...finalFit,
    trainedAt: new Date().toISOString(),
    examples: rows.length,
    validationLogLoss,
    validationAccuracy,
  };
}

function rawWeights(model: LogisticModel): { weights: number[]; bias: number } {
  const weights = model.weights.map((weight, i) => weight / model.scale[i]!);
  const bias = model.bias - weights.reduce((sum, weight, i) => sum + weight * model.mean[i]!, 0);
  return { weights, bias };
}

function tensorValueInfo(name: string, dimensions: Array<{ dimValue?: number; dimParam?: string }>) {
  return onnx.ValueInfoProto.create({
    name,
    type: onnx.TypeProto.create({
      tensorType: onnx.TypeProto.Tensor.create({
        elemType: onnx.TensorProto.DataType.FLOAT,
        shape: onnx.TensorShapeProto.create({ dim: dimensions }),
      }),
    }),
  });
}

export async function exportDraftModelOnnx(model: LogisticModel, outputPath: string): Promise<void> {
  if (model.featureCount !== DRAFT_FEATURE_COUNT || model.weights.length !== DRAFT_FEATURE_COUNT) {
    throw new Error('Cannot export a model with a mismatched feature schema');
  }
  const raw = rawWeights(model);
  const proto = onnx.ModelProto.create({
    irVersion: 8,
    producerName: 'Itachio analytics',
    producerVersion: '1.0.0',
    graph: onnx.GraphProto.create({
      name: 'itachio_draft_logistic',
      input: [tensorValueInfo('features', [{ dimParam: 'batch' }, { dimValue: DRAFT_FEATURE_COUNT }])],
      output: [tensorValueInfo('win_probability', [{ dimParam: 'batch' }, { dimValue: 1 }])],
      initializer: [
        onnx.TensorProto.create({ dims: [DRAFT_FEATURE_COUNT, 1], dataType: onnx.TensorProto.DataType.FLOAT, floatData: raw.weights, name: 'weights' }),
        onnx.TensorProto.create({ dims: [1], dataType: onnx.TensorProto.DataType.FLOAT, floatData: [raw.bias], name: 'bias' }),
      ],
      node: [
        onnx.NodeProto.create({ name: 'linear', opType: 'MatMul', input: ['features', 'weights'], output: ['linear_output'] }),
        onnx.NodeProto.create({ name: 'bias_add', opType: 'Add', input: ['linear_output', 'bias'], output: ['logits'] }),
        onnx.NodeProto.create({ name: 'probability', opType: 'Sigmoid', input: ['logits'], output: ['win_probability'] }),
      ],
    }),
    opsetImport: [onnx.OperatorSetIdProto.create({ domain: '', version: 13 })],
  });
  const invalid = onnx.ModelProto.verify(proto);
  if (invalid) throw new Error(`Invalid ONNX model: ${invalid}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(onnx.ModelProto.encode(proto).finish()));
}

export async function saveModelJson(model: LogisticModel, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(model)}\n`, 'utf8');
}
