CREATE DATABASE IF NOT EXISTS itachio;

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
ORDER BY (patch, queue_id, match_id);

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
ORDER BY (patch, queue_id, match_id, team_side, lane_id, champion_id);