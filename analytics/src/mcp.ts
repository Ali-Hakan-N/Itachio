import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ClickHouseClient } from '@clickhouse/client';

export const LATEST_PATCH_SQL = `
SELECT max(patch) AS patch
FROM itachio.matches FINAL
WHERE queue_id = {queueId:UInt16}`;

export const ANALYZE_MATCHUP_SQL = `
WITH tier_weights AS (
  SELECT rank_tier, count() AS tier_games
  FROM itachio.matches FINAL
  WHERE patch = {patch:String}
    AND queue_id = {queueId:UInt16}
    AND rank_tier != 'UNKNOWN'
  GROUP BY rank_tier
),
participant_rows AS (
  SELECT
    match_id,
    rank_tier,
    JSONExtractInt(participant, 'champion_id') AS champion_id,
    JSONExtractString(participant, 'lane_id') AS lane_id,
    JSONExtractUInt(participant, 'won') AS won
  FROM itachio.matches FINAL
  ARRAY JOIN JSONExtractArrayRaw(participants_json) AS participant
  WHERE patch = {patch:String}
    AND queue_id = {queueId:UInt16}
    AND rank_tier != 'UNKNOWN'
    AND lane_id = {lane:String}
    AND champion_id IN ({championA:Int16}, {championB:Int16})
),
pair_results AS (
  SELECT
    match_id,
    rank_tier,
    maxIf(won, champion_id = {championA:Int16}) AS champion_a_won,
    countIf(champion_id = {championA:Int16}) AS champion_a_count,
    countIf(champion_id = {championB:Int16}) AS champion_b_count
  FROM participant_rows
  GROUP BY match_id, rank_tier
  HAVING champion_a_count = 1 AND champion_b_count = 1
),
tier_rates AS (
  SELECT rank_tier, count() AS pair_games, avg(champion_a_won) AS win_rate
  FROM pair_results
  GROUP BY rank_tier
)
SELECT
  sum(tier_rates.win_rate * tier_weights.tier_games) / sum(tier_weights.tier_games) AS win_rate,
  sum(tier_rates.pair_games) AS games,
  count() AS represented_tiers
FROM tier_rates
INNER JOIN tier_weights USING (rank_tier)`;

export interface MatchupResult {
  championA: number;
  championB: number;
  lane: string;
  patch: string;
  queueId: number;
  winRate: number;
  games: number;
  representedTiers: number;
}

async function queryRows<T>(client: ClickHouseClient, query: string, queryParams: Record<string, unknown>): Promise<T[]> {
  const result = await client.query({ query, format: 'JSONEachRow', query_params: queryParams });
  return result.json<T>();
}

export async function analyzeMatchup(
  client: ClickHouseClient,
  input: { champion_a: number; champion_b: number; lane: string; patch?: string | undefined; queue_id?: 420 | 440 | undefined },
): Promise<MatchupResult> {
  if (input.champion_a === input.champion_b) throw new Error('champion_a and champion_b must differ');
  const lane = input.lane.toUpperCase();
  if (!['TOP', 'JNG', 'MID', 'ADC', 'SUP'].includes(lane)) throw new Error('lane must be TOP, JNG, MID, ADC, or SUP');
  const queueId = input.queue_id ?? 420;
  const patch = input.patch || (await queryRows<{ patch: string }>(client, LATEST_PATCH_SQL, { queueId }))[0]?.patch;
  if (!patch) throw new Error('No matches are available for this queue');
  const rows = await queryRows<{ win_rate: number | string; games: number | string; represented_tiers: number | string }>(
    client,
    ANALYZE_MATCHUP_SQL,
    { patch, queueId, lane, championA: input.champion_a, championB: input.champion_b },
  );
  const row = rows[0];
  if (!row || Number(row.games) === 0) throw new Error('No same-lane matchup observations with known rank tiers');
  return {
    championA: input.champion_a,
    championB: input.champion_b,
    lane,
    patch,
    queueId,
    winRate: Number(row.win_rate),
    games: Number(row.games),
    representedTiers: Number(row.represented_tiers),
  };
}

export function createAnalyticsMcpHandler(client: ClickHouseClient) {
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'itachio-analytics', version: '1.0.0' });
    server.registerTool(
      'analyze_matchup',
      {
        title: 'Analyze champion matchup',
        description: 'Calculate same-lane win rate standardized to the patch and queue rank-tier distribution.',
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: z.object({
          champion_a: z.number().int().min(1).max(32767),
          champion_b: z.number().int().min(1).max(32767),
          lane: z.enum(['TOP', 'JNG', 'MID', 'ADC', 'SUP']),
          patch: z.string().regex(/^\d+\.\d+$/).optional(),
          queue_id: z.union([z.literal(420), z.literal(440)]).optional(),
        }),
        outputSchema: z.object({
          championA: z.number(), championB: z.number(), lane: z.string(), patch: z.string(),
          queueId: z.number(), winRate: z.number(), games: z.number(), representedTiers: z.number(),
        }),
      },
      async (input) => {
        const result = await analyzeMatchup(client, input);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      },
    );
    return server;
  });
}