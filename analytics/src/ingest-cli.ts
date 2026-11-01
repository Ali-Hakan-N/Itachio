import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { createAnalyticsClient, ensureSchema, insertDraftObservations, insertMatches } from './clickhouse.js';
import { buildTrainingObservations, compactMatchToRiotMatch, isCompactMatch } from './training-data.js';

async function loadRankTiers(path: string | undefined): Promise<Record<string, string>> {
  if (!path) return {};
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
}

async function main() {
  const inputPath = process.argv[2];
  const rankTierPath = process.argv[3];
  if (!inputPath) throw new Error('Usage: npm run ingest -- <compact-match-jsonl> [rank-tier-map.json]');
  const ranks = await loadRankTiers(rankTierPath);
  const patchFallback = /^([0-9]+\.[0-9]+)\.jsonl$/i.exec(basename(inputPath))?.[1];
  const compact = [];
  let skipped = 0;
  const lines = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as unknown;
    if (!isCompactMatch(row, patchFallback)) { skipped++; continue; }
    compact.push(row);
  }
  const matches = compact.map((row) => compactMatchToRiotMatch(row, patchFallback));
  const rankTierByMatch = ranks;
  const observations = buildTrainingObservations(matches, {
    priorFraction: 0.7,
    minimumPriorMatches: 500,
    maxFutureMatches: Number(process.env.DRAFT_TRAIN_MATCHES || 20_000),
    rankTierByMatch,
  });
  const client = createAnalyticsClient();
  let insertedMatches = 0;
  let insertedObservations = 0;
  try {
    await ensureSchema(client);
    for (let offset = 0; offset < matches.length; offset += 1000) {
      const batch = matches.slice(offset, offset + 1000).map((match) => ({
        match,
        context: { region: regionForMatch(match.metadata.matchId), rankTier: ranks[match.metadata.matchId] || 'UNKNOWN' },
      }));
      await insertMatches(client, batch);
      insertedMatches += batch.length;
    }
    for (let offset = 0; offset < observations.length; offset += 1000) {
      const batch = observations.slice(offset, offset + 1000);
      await insertDraftObservations(client, batch);
      insertedObservations += batch.length;
    }
    console.log(JSON.stringify({ matches: insertedMatches, observations: insertedObservations, skipped, rankTierEnriched: Object.keys(ranks).length }));
  } finally {
    await client.close();
  }
}

function regionForMatch(matchId: string): string {
  const platform = matchId.split('_')[0]?.toUpperCase() || '';
  if (['NA1', 'BR1', 'LA1', 'LA2'].includes(platform)) return 'AMERICAS';
  if (['KR', 'JP1'].includes(platform)) return 'ASIA';
  if (['OC1', 'SG2', 'TW2', 'VN2'].includes(platform)) return 'SEA';
  return 'EUROPE';
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});