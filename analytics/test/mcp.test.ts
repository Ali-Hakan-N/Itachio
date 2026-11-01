import assert from 'node:assert/strict';
import test from 'node:test';
import { ANALYZE_MATCHUP_SQL, analyzeMatchup, LATEST_PATCH_SQL } from '../src/mcp.js';

test('matchup MCP query binds all values and standardizes by patch rank-tier distribution', () => {
  assert.match(ANALYZE_MATCHUP_SQL, /rank_tier != 'UNKNOWN'/);
  assert.match(ANALYZE_MATCHUP_SQL, /tier_rates\.win_rate \* tier_weights\.tier_games/);
  assert.match(ANALYZE_MATCHUP_SQL, /\{championA:Int16\}/);
  assert.match(ANALYZE_MATCHUP_SQL, /\{championB:Int16\}/);
  assert.match(ANALYZE_MATCHUP_SQL, /\{lane:String\}/);
  assert.match(ANALYZE_MATCHUP_SQL, /\{patch:String\}/);
  assert.match(LATEST_PATCH_SQL, /\{queueId:UInt16\}/);
});

test('matchup tool resolves latest patch and sends all dynamic values as ClickHouse parameters', async () => {
  const calls: Array<{ query: string; query_params?: Record<string, unknown> }> = [];
  const fake = {
    query: async (request: { query: string; query_params?: Record<string, unknown> }) => {
      calls.push(request);
      return { json: async () => request.query === LATEST_PATCH_SQL
        ? [{ patch: '16.21' }]
        : [{ win_rate: 0.57, games: 240, represented_tiers: 5 }] };
    },
  };
  const result = await analyzeMatchup(fake as never, { champion_a: 1, champion_b: 2, lane: 'top', queue_id: 420 });
  assert.equal(result.patch, '16.21');
  assert.equal(result.winRate, 0.57);
  assert.equal(result.games, 240);
  assert.equal(calls[1]!.query_params?.championA, 1);
  assert.equal(calls[1]!.query_params?.championB, 2);
  assert.equal(calls[1]!.query_params?.lane, 'TOP');
});

test('matchup query rejects self-matchups before querying ClickHouse', async () => {
  let queried = false;
  const fake = { query: async () => { queried = true; throw new Error('must not query'); } };
  await assert.rejects(() => analyzeMatchup(fake as never, { champion_a: 1, champion_b: 1, lane: 'TOP' }), /must differ/);
  assert.equal(queried, false);
});