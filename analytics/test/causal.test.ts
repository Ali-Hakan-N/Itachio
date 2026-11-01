import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateCATE, generateCausalInsight, type CausalMatch } from '../src/causal.js';

function makeMatches(count: number): CausalMatch[] {
  let seed = 41;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  return Array.from({ length: count }, (_, index) => {
    const gold = 500 + random() * 2500;
    const treatmentChance = 0.15 + 0.7 * (gold / 3000);
    const controlWardBefore5 = Number(random() < treatmentChance) as 0 | 1;
    const winChance = 1 / (1 + Math.exp(-(-0.25 + (gold / 3000 - 0.5) * 0.8 + controlWardBefore5 * 0.45)));
    return {
      matchId: `match-${index}`,
      won: Number(random() < winChance) as 0 | 1,
      controlWardBefore5,
      goldBefore5: gold,
      csBefore5: random() * 35,
      levelBefore5: 3 + random() * 2,
      priorControlWardRate: random(),
      championPriorWinRate: 0.4 + random() * 0.2,
      rankTier: Math.floor(random() * 7),
      role: (['TOP', 'JNG', 'MID', 'ADC', 'SUP'] as const)[index % 5]!,
      patchAge: random() * 12,
      goldAt10: gold + controlWardBefore5 * 100 + random() * 1000,
    };
  });
}

test('cross-fitted CATE estimates treatment from pre-treatment confounders', () => {
  const estimate = estimateCATE({ matches: makeMatches(600) });
  assert.equal(estimate.observations, 600);
  assert.ok(estimate.treated >= 20);
  assert.ok(estimate.untreated >= 20);
  assert.ok(Number.isFinite(estimate.effect));
  assert.ok(Number.isFinite(estimate.standardError));
  assert.ok(estimate.confidenceInterval[0] <= estimate.effect);
  assert.ok(estimate.confidenceInterval[1] >= estimate.effect);
  assert.ok(estimate.averageGoldAt10 > 0);
});

test('insight response uses a strict three-field shape and computes numeric values without an LLM key', async () => {
  const response = await generateCausalInsight({ matches: makeMatches(600) }, { apiKey: '' });
  assert.deepEqual(Object.keys(response).sort(), ['causal_delta', 'confidence_interval', 'insight']);
  assert.equal(response.confidence_interval.length, 2);
  assert.ok(Number.isFinite(response.causal_delta));
  assert.match(response.insight, /post-treatment outcome/);
});

test('LLM narration cannot replace the computed treatment effect or interval', async () => {
  const data = { matches: makeMatches(600) };
  const estimate = estimateCATE(data);
  let requestBody: Record<string, unknown> | null = null;
  const fetcher: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ insight: 'A cautiously phrased estimate.' }) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const response = await generateCausalInsight(data, { apiKey: 'test-key', fetcher });
  assert.deepEqual(Object.keys(response).sort(), ['causal_delta', 'confidence_interval', 'insight']);
  assert.equal(response.causal_delta, estimate.effect * 100);
  assert.deepEqual(response.confidence_interval, estimate.confidenceInterval.map((value) => value * 100));
  assert.deepEqual((requestBody as any)?.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'causal_insight_text',
      strict: true,
      schema: { type: 'object', properties: { insight: { type: 'string' } }, required: ['insight'], additionalProperties: false },
    },
  });
});

test('causal inference refuses undersized samples', () => {
  assert.throws(() => estimateCATE({ matches: makeMatches(50) }), /At least 100/);
});