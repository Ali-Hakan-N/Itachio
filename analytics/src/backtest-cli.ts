import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { chronologicalSplit, headToHead, trainHybrid, type MetaPrior } from './hybrid.js';
import { loadCompactMatches } from './match-files.js';
import type { CompactMatch } from './training-data.js';

// Head-to-head on the same chronological, match-grouped split: the candidate replaces the
// production model only if its logloss gain on the newest matches is above 2 standard errors.
// Reads local files and fits in memory; it uploads nothing.

const require = createRequire(import.meta.url);
const { roleShares } = require('../../collector/src/model/features.js');
const { train } = require('../../collector/src/model/train.js');
const { exportModel } = require('../../collector/src/model/index.js');
const { matchLogit } = require('../../collector/src/model/predict.js');

async function championTags(): Promise<Map<number, string>> {
  try {
    const versions = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json() as string[];
    const body = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/en_US/champion.json`)).json() as { data: Record<string, { key: string; tags: string[] }> };
    return new Map(Object.values(body.data).map((champion) => [Number(champion.key), champion.tags[0] || 'None']));
  } catch {
    console.warn('backtest: Data Dragon unavailable, class features are off for the production model');
    return new Map();
  }
}

async function main() {
  const inputPaths = process.argv.slice(2);
  if (!inputPaths.length) throw new Error('Usage: npm run backtest -- <collector-match-jsonl>...');
  const outputPath = resolve(process.env.BACKTEST_REPORT || 'models/backtest.json');
  const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  const { matches, compact } = await loadCompactMatches(inputPaths.map((path) => resolve(path)));
  const { development, test } = chronologicalSplit(matches, Number(process.env.BACKTEST_TEST_SHARE || 0.3));
  const byId = new Map(compact.map((row) => [row.id, row]));
  const devCompact = development.map((match) => byId.get(match.metadata.matchId)!);
  const testCompact = test.map((match) => byId.get(match.metadata.matchId)!);
  log(`${development.length} development matches, ${test.length} test matches`);
  const labels = new Map(testCompact.map((row) => [row.id, row.w as number]));
  const blueRate = devCompact.reduce((sum, row) => sum + row.w, 0) / devCompact.length;
  const baselineLogit = Math.log(blueRate / (1 - blueRate));
  const report: Record<string, unknown> = { trainedAt: new Date().toISOString(), inputs: inputPaths, development: development.length, test: test.length };

  const metaPrior = process.env.META_PRIOR_PATH ? JSON.parse(await readFile(resolve(process.env.META_PRIOR_PATH), 'utf8')) as MetaPrior : null;
  log('candidate: training');
  const t0 = Date.now();
  const candidateModel = trainHybrid(development, { maxTrainMatches: Number(process.env.DRAFT_TRAIN_MATCHES || 30_000), metaPrior, log });
  const candidate = candidateModel.predict(test);
  log(`candidate: done in ${Math.round((Date.now() - t0) / 1000)}s`);
  report.candidate = { trees: candidateModel.model.gbdt.trees.length, evidenceK: candidateModel.model.evidenceK, priorMatches: candidateModel.model.priorMatches, trainMatches: candidateModel.model.trainMatches };
  const zero = new Map([...labels.keys()].map((id) => [id, baselineLogit]));
  report.candidateVsBaseline = headToHead(labels, candidate, zero, baselineLogit);
  log(`candidate vs base rate: ${JSON.stringify(report.candidateVsBaseline)}`);

  log('production: training with its normal settings');
  const t1 = Date.now();
  const tags = await championTags();
  const { share, games } = roleShares(devCompact);
  const trained = train(devCompact, { share, tagOf: (id: number) => tags.get(id) || 'None' }, { log });
  const data = exportModel(trained, { share, games, tags, patch: process.env.BACKTEST_PATCH || 'backtest', matches: devCompact.length, matchRows: devCompact });
  const logit = matchLogit(data) as (row: CompactMatch) => number;
  const production = new Map(testCompact.map((row) => [row.id, logit(row)]));
  log(`production: done in ${Math.round((Date.now() - t1) / 1000)}s`);
  report.production = { layers: trained.metrics.layers, recency: trained.metrics.recency, cvLogLoss: trained.metrics.logloss };
  report.headToHead = headToHead(labels, candidate, production, baselineLogit);

  // What the class fallback for rare champions adds to the production model
  if (data.fm?.prior) {
    const withoutPrior = matchLogit({ ...data, fm: { ...data.fm, prior: undefined } }) as (row: CompactMatch) => number;
    report.latentClassPrior = headToHead(labels, production, new Map(testCompact.map((row) => [row.id, withoutPrior(row)])), baselineLogit);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  log(`head to head: ${JSON.stringify(report.headToHead, null, 2)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
