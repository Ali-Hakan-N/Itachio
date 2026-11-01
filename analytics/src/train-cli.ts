import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, resolve } from 'node:path';
import { exportDraftModelOnnx, saveModelJson, trainDraftModel } from './training.js';
import { buildTrainingObservations, compactMatchToRiotMatch, isCompactMatch } from './training-data.js';

async function loadCompactMatches(filePath: string) {
  const matches = [];
  let skipped = 0;
  const patchFallback = /^(\d+\.\d+)\.jsonl$/i.exec(basename(filePath))?.[1];
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const compact = JSON.parse(line) as unknown;
    if (!isCompactMatch(compact, patchFallback)) { skipped++; continue; }
    matches.push(compactMatchToRiotMatch(compact, patchFallback));
  }
  return { matches, skipped };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Usage: npm run train -- <collector-match-jsonl>');
  const outputPath = resolve(process.env.DRAFT_ONNX_PATH || 'models/draft.onnx');
  const { matches, skipped } = await loadCompactMatches(resolve(inputPath));
  const observations = buildTrainingObservations(matches, {
    priorFraction: 0.7,
    minimumPriorMatches: 500,
    maxFutureMatches: Number(process.env.DRAFT_TRAIN_MATCHES || 20_000),
  });
  const model = trainDraftModel(observations, {
    epochs: Number(process.env.DRAFT_TRAIN_EPOCHS || 40),
    learningRate: 0.12,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await Promise.all([exportDraftModelOnnx(model, outputPath), saveModelJson(model, outputPath.replace(/\.onnx$/i, '.json'))]);
  console.log(JSON.stringify({
    matches: matches.length,
    skipped,
    observations: model.examples,
    validationLogLoss: model.validationLogLoss,
    validationAccuracy: model.validationAccuracy,
    modelPath: outputPath,
    trainedAt: model.trainedAt,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});