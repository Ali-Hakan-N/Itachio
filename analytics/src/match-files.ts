import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { compactMatchToRiotMatch, isCompactMatch, matchTime, type CompactMatch } from './training-data.js';
import type { RiotMatchV5 } from './clickhouse.js';

/** Reads collector JSONL files: the Match-V5 shape for the draft model, the compact rows for the production trainer */
export async function loadCompactMatches(filePaths: readonly string[]) {
  const seen = new Set<string>();
  const matches: RiotMatchV5[] = [];
  const compact: CompactMatch[] = [];
  let skipped = 0;
  for (const filePath of filePaths) {
    const patchFallback = /^(\d+\.\d+)\.jsonl$/i.exec(basename(filePath))?.[1];
    const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        skipped++; // a line cut off by a crash
        continue;
      }
      if (!isCompactMatch(row, patchFallback) || seen.has(row.id)) { skipped++; continue; }
      seen.add(row.id);
      compact.push(row);
      matches.push(compactMatchToRiotMatch(row, patchFallback));
    }
  }
  return { matches, compact, skipped };
}

/** Matches without a start time predate the field: they go first, then the rest by time */
export function orderOldestFirst<T extends RiotMatchV5>(matches: readonly T[]): T[] {
  return [...matches].sort((a, b) => matchTime(a) - matchTime(b));
}
