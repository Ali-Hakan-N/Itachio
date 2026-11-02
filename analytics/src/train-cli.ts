import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { saveHybrid, trainHybrid, type MetaPrior } from './hybrid.js';
import { loadCompactMatches, orderOldestFirst } from './match-files.js';

async function main() {
  const inputPaths = process.argv.slice(2);
  if (!inputPaths.length) throw new Error('Usage: npm run train -- <collector-match-jsonl>...');
  const outputPath = resolve(process.env.DRAFT_ONNX_PATH || 'models/draft.onnx');
  const { matches, skipped } = await loadCompactMatches(inputPaths.map((path) => resolve(path)));
  const metaPrior = process.env.META_PRIOR_PATH ? JSON.parse(await readFile(resolve(process.env.META_PRIOR_PATH), 'utf8')) as MetaPrior : null;
  const { model } = trainHybrid(orderOldestFirst(matches), {
    maxTrainMatches: Number(process.env.DRAFT_TRAIN_MATCHES || 30_000),
    metaPrior,
    log: console.log,
  });
  await saveHybrid(model, outputPath);
  console.log(JSON.stringify({
    matches: matches.length,
    skipped,
    priorMatches: model.priorMatches,
    trainMatches: model.trainMatches,
    trees: model.gbdt.trees.length,
    evidenceK: model.evidenceK,
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
