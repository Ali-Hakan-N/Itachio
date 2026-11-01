import { createClient } from '@clickhouse/client';
import type { ClickHouseClient } from '@clickhouse/client';
import { validateDraftStateVector, type DraftStateVector, type LaneId, type TeamSide } from './features.js';

const LANES: Record<string, LaneId> = {
  TOP: 'TOP',
  JUNGLE: 'JNG',
  MIDDLE: 'MID',
  BOTTOM: 'ADC',
  UTILITY: 'SUP',
};

export interface RiotMatchV5Participant {
  championId: number;
  teamId: number;
  teamPosition?: string;
  win: boolean;
  kills?: number;
  deaths?: number;
  assists?: number;
  goldEarned?: number;
  totalMinionsKilled?: number;
  neutralMinionsKilled?: number;
  magicDamageDealtToChampions?: number;
  physicalDamageDealtToChampions?: number;
  trueDamageDealtToChampions?: number;
  totalDamageTaken?: number;
  totalHeal?: number;
  totalTimeCCDealt?: number;
  timeCCingOthers?: number;
  wardsPlaced?: number;
  visionWardsBoughtInGame?: number;
  item0?: number;
  item1?: number;
  item2?: number;
  item3?: number;
  item4?: number;
  item5?: number;
}

export interface RiotMatchV5 {
  metadata: { matchId: string };
  info: {
    queueId: number;
    gameVersion: string;
    gameStartTimestamp?: number;
    gameCreation?: number;
    gameDuration: number;
    participants: RiotMatchV5Participant[];
    teams: Array<{ teamId: number; win: boolean; bans?: Array<{ championId: number }> }>;
  };
}

export interface IngestContext {
  region: string;
  rankTier?: string;
}

export interface MatchInsertRecord {
  match: RiotMatchV5;
  context: IngestContext;
}

export const MATCH_INSERT_SQL = `
INSERT INTO itachio.matches
(match_id, patch, queue_id, region, rank_tier, started_at, duration_s, blue_win, bans, participants_json)
FORMAT JSONEachRow`;

export const DRAFT_OBSERVATION_INSERT_SQL = `
INSERT INTO itachio.draft_observations
(match_id, patch, queue_id, rank_tier, champion_id, team_side, lane_id, base_winrate,
 matchup_winrate, synergy_score, damage_profile, cc_score, features, won)
FORMAT JSONEachRow`;

const MATCH_COLUMNS: [string, ...string[]] = [
  'match_id', 'patch', 'queue_id', 'region', 'rank_tier', 'started_at', 'duration_s', 'blue_win', 'bans', 'participants_json',
];

const PATCH_RE = /^(\d+)\.(\d+)/;
const patchFromVersion = (version: string): string => {
  const match = PATCH_RE.exec(version);
  if (!match) throw new Error(`Invalid Riot gameVersion: ${version}`);
  return `${match[1]}.${match[2]}`;
};

const isoTimestamp = (match: RiotMatchV5): string | null => {
  const timestamp = match.info.gameStartTimestamp ?? match.info.gameCreation;
  if (!Number.isFinite(timestamp) || !timestamp) return null;
  return new Date(timestamp).toISOString().replace('T', ' ').replace('Z', '');
};

export function toMatchInsertRow(match: RiotMatchV5, context: IngestContext) {
  if (!match.metadata?.matchId || !Array.isArray(match.info?.participants)) throw new Error('Invalid Match-V5 payload');
  const blue = match.info.teams.find((team) => team.teamId === 100);
  if (!blue) throw new Error('Match-V5 payload has no blue team');
  const bans = match.info.teams.flatMap((team) => team.bans || []).map((ban) => ban.championId).filter((id) => id > 0);
  const participants = match.info.participants.map((p) => ({
    champion_id: p.championId,
    team_side: p.teamId === 100 ? 'blue' as TeamSide : 'red' as TeamSide,
    lane_id: LANES[p.teamPosition || ''] || 'UNKNOWN',
    won: Number(p.win),
    kills: p.kills || 0,
    deaths: p.deaths || 0,
    assists: p.assists || 0,
    gold_earned: p.goldEarned || 0,
    minions: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
    magic_damage: p.magicDamageDealtToChampions || 0,
    physical_damage: p.physicalDamageDealtToChampions || 0,
    true_damage: p.trueDamageDealtToChampions || 0,
    damage_taken: p.totalDamageTaken || 0,
    total_heal: p.totalHeal || 0,
    cc_seconds: p.timeCCingOthers || p.totalTimeCCDealt || 0,
    wards_placed: p.wardsPlaced || 0,
    control_wards: p.visionWardsBoughtInGame || 0,
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5].map((id) => id || 0),
  }));
  return {
    match_id: match.metadata.matchId,
    patch: patchFromVersion(match.info.gameVersion),
    queue_id: match.info.queueId,
    region: context.region.toUpperCase(),
    rank_tier: context.rankTier?.toUpperCase() || 'UNKNOWN',
    started_at: isoTimestamp(match),
    duration_s: match.info.gameDuration,
    blue_win: Number(blue.win),
    bans,
    participants_json: JSON.stringify(participants),
  };
}

export function createAnalyticsClient(env: NodeJS.ProcessEnv = process.env): ClickHouseClient {
  const url = env.CLICKHOUSE_URL;
  if (!url) throw new Error('CLICKHOUSE_URL is required');
  return createClient({
    url,
    username: env.CLICKHOUSE_USER || 'default',
    password: env.CLICKHOUSE_PASSWORD || '',
    database: env.CLICKHOUSE_DATABASE || 'itachio',
    application: 'itachio-analytics',
    request_timeout: 30_000,
  });
}

export async function insertMatch(client: ClickHouseClient, match: RiotMatchV5, context: IngestContext): Promise<void> {
  await insertMatches(client, [{ match, context }]);
}

export async function insertMatches(client: ClickHouseClient, records: readonly MatchInsertRecord[]): Promise<void> {
  if (!records.length) return;
  const rows = records.map(({ match, context }) => toMatchInsertRow(match, context));
  await client.insert({
    table: 'itachio.matches',
    columns: MATCH_COLUMNS,
    values: rows,
    format: 'JSONEachRow',
  });
}

export async function insertDraftObservations(client: ClickHouseClient, rows: readonly DraftStateVector[]): Promise<void> {
  for (const row of rows) validateDraftStateVector(row);
  if (!rows.length) return;
  await client.insert({
    table: 'itachio.draft_observations',
    columns: [
      'match_id', 'patch', 'queue_id', 'rank_tier', 'champion_id', 'team_side', 'lane_id', 'base_winrate',
      'matchup_winrate', 'synergy_score', 'damage_profile', 'cc_score', 'features', 'won',
    ],
    values: rows.map((row) => ({ ...row })),
    format: 'JSONEachRow',
  });
}

export async function ensureSchema(client: ClickHouseClient): Promise<void> {
  await client.command({ query: `CREATE DATABASE IF NOT EXISTS itachio` });
  await client.command({ query: `
    CREATE TABLE IF NOT EXISTS itachio.matches
    (
      match_id String,
      patch LowCardinality(String),
      queue_id UInt16,
      region LowCardinality(String),
      rank_tier LowCardinality(String),
      started_at Nullable(DateTime64(3, 'UTC')),
      duration_s UInt32,
      blue_win UInt8,
      bans Array(Int16),
      participants_json String,
      ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
    )
    ENGINE = ReplacingMergeTree(ingested_at)
    ORDER BY (patch, queue_id, match_id)
  ` });
  await client.command({ query: `
    CREATE TABLE IF NOT EXISTS itachio.draft_observations
    (
      match_id String,
      patch LowCardinality(String),
      queue_id UInt16,
      rank_tier LowCardinality(String),
      champion_id Int16,
      team_side LowCardinality(String),
      lane_id LowCardinality(String),
      base_winrate Float32,
      matchup_winrate Float32,
      synergy_score Float32,
      damage_profile Tuple(Float32, Float32, Float32),
      cc_score Float32,
      features Array(Float32),
      won UInt8,
      ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
    )
    ENGINE = ReplacingMergeTree(ingested_at)
    ORDER BY (patch, queue_id, match_id, team_side, lane_id, champion_id)
  ` });
}