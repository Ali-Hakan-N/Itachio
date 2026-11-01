export interface CausalMatch {
  matchId: string;
  won: 0 | 1;
  controlWardBefore5: 0 | 1;
  goldBefore5: number;
  csBefore5: number;
  levelBefore5: number;
  priorControlWardRate: number;
  championPriorWinRate: number;
  rankTier: number;
  role: 'TOP' | 'JNG' | 'MID' | 'ADC' | 'SUP';
  patchAge: number;
  goldAt10: number;
}

export interface SummonerData {
  matches: readonly CausalMatch[];
}

export interface CausalEstimate {
  effect: number;
  standardError: number;
  confidenceInterval: [number, number];
  observations: number;
  treated: number;
  untreated: number;
  averageGoldAt10: number;
}

export type CausalInsight = {
  insight: string;
  causal_delta: number;
  confidence_interval: [number, number];
};

const ROLES = ['TOP', 'JNG', 'MID', 'ADC', 'SUP'] as const;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const sigmoid = (value: number): number => 1 / (1 + Math.exp(-clamp(value, -25, 25)));

function confounders(row: CausalMatch): number[] {
  return [
    row.goldBefore5 / 1000,
    row.csBefore5 / 20,
    row.levelBefore5 / 6,
    row.priorControlWardRate,
    row.championPriorWinRate - 0.5,
    row.rankTier / 6,
    row.patchAge / 12,
    ...ROLES.map((role) => Number(row.role === role)),
  ];
}

function standardize(rows: readonly CausalMatch[]): number[][] {
  const raw = rows.map(confounders);
  const width = raw[0]?.length || 0;
  const mean = new Array<number>(width).fill(0);
  const scale = new Array<number>(width).fill(0);
  for (const row of raw) for (let i = 0; i < width; i++) mean[i] = mean[i]! + row[i]! / raw.length;
  for (const row of raw) for (let i = 0; i < width; i++) scale[i] = scale[i]! + ((row[i]! - mean[i]!) ** 2) / raw.length;
  for (let i = 0; i < width; i++) scale[i] = Math.sqrt(scale[i]!) || 1;
  return raw.map((row) => [1, ...row.map((value, i) => (value - mean[i]!) / scale[i]!)]);
}

function fitLogistic(x: readonly number[][], y: readonly number[], indices: readonly number[]): number[] {
  const weights = new Array<number>(x[0]!.length).fill(0);
  const rate = 0.03;
  for (let epoch = 0; epoch < 300; epoch++) {
    const gradient = new Array<number>(weights.length).fill(0);
    for (const index of indices) {
      const prediction = sigmoid(x[index]!.reduce((sum, value, i) => sum + value * weights[i]!, 0));
      for (let i = 0; i < weights.length; i++) gradient[i] = gradient[i]! + (prediction - y[index]!) * x[index]![i]!;
    }
    const step = rate / indices.length;
    for (let i = 0; i < weights.length; i++) weights[i] = weights[i]! - step * (gradient[i]! + (i ? 0.01 * weights[i]! : 0));
  }
  return weights;
}

function fitLinear(x: readonly number[][], y: readonly number[], indices: readonly number[]): number[] {
  const weights = new Array<number>(x[0]!.length).fill(0);
  const rate = 0.01;
  for (let epoch = 0; epoch < 500; epoch++) {
    const gradient = new Array<number>(weights.length).fill(0);
    for (const index of indices) {
      const prediction = x[index]!.reduce((sum, value, i) => sum + value * weights[i]!, 0);
      for (let i = 0; i < weights.length; i++) gradient[i] = gradient[i]! + 2 * (prediction - y[index]!) * x[index]![i]!;
    }
    const step = rate / indices.length;
    for (let i = 0; i < weights.length; i++) weights[i] = weights[i]! - step * (gradient[i]! + (i ? 0.02 * weights[i]! : 0));
  }
  return weights;
}

function solve(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  const augmented = matrix.map((row, i) => [...row, vector[i]!]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const divisor = augmented[column]![column]!;
    if (Math.abs(divisor) < 1e-10) throw new Error('Causal model is singular; more confounder variation is required');
    for (let i = column; i <= n; i++) augmented[column]![i] = augmented[column]![i]! / divisor;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let i = column; i <= n; i++) augmented[row]![i] = augmented[row]![i]! - factor * augmented[column]![i]!;
    }
  }
  return augmented.map((row) => row[n]!);
}

function inverse(matrix: number[][]): number[][] {
  const n = matrix.length;
  const augmented = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => Number(i === j))]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const divisor = augmented[column]![column]!;
    if (Math.abs(divisor) < 1e-10) throw new Error('Causal covariance matrix is singular');
    for (let i = 0; i < 2 * n; i++) augmented[column]![i] = augmented[column]![i]! / divisor;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let i = 0; i < 2 * n; i++) augmented[row]![i] = augmented[row]![i]! - factor * augmented[column]![i]!;
    }
  }
  return augmented.map((row) => row.slice(n));
}

export function estimateCATE(data: SummonerData, folds = 5): CausalEstimate {
  const rows = data.matches;
  if (rows.length < 100) throw new Error(`At least 100 ranked matches are required; received ${rows.length}`);
  const treated = rows.filter((row) => row.controlWardBefore5 === 1).length;
  const untreated = rows.length - treated;
  if (treated < 20 || untreated < 20) throw new Error('Both treated and untreated groups need at least 20 matches');
  const x = standardize(rows);
  const treatment = rows.map((row) => row.controlWardBefore5);
  const outcome = rows.map((row) => row.won);
  const propensity = new Array<number>(rows.length).fill(0);
  const outcomeMean = new Array<number>(rows.length).fill(0);
  const foldCount = Math.max(2, Math.min(folds, Math.floor(rows.length / 20)));

  for (let fold = 0; fold < foldCount; fold++) {
    const train = rows.map((_, index) => index).filter((index) => index % foldCount !== fold);
    const holdout = rows.map((_, index) => index).filter((index) => index % foldCount === fold);
    const propensityWeights = fitLogistic(x, treatment, train);
    const outcomeWeights = fitLinear(x, outcome, train);
    for (const index of holdout) {
      propensity[index] = clamp(sigmoid(x[index]!.reduce((sum, value, i) => sum + value * propensityWeights[i]!, 0)), 0.05, 0.95);
      outcomeMean[index] = clamp(x[index]!.reduce((sum, value, i) => sum + value * outcomeWeights[i]!, 0), 0, 1);
    }
  }

  const residualTreatment = treatment.map((value, index) => value - propensity[index]!);
  const residualOutcome = outcome.map((value, index) => value - outcomeMean[index]!);
  const width = x[0]!.length;
  const normal = Array.from({ length: width }, () => new Array<number>(width).fill(0));
  const target = new Array<number>(width).fill(0);
  for (let row = 0; row < rows.length; row++) {
    const weight = residualTreatment[row]! ** 2;
    for (let i = 0; i < width; i++) {
      target[i] = target[i]! + residualTreatment[row]! * x[row]![i]! * residualOutcome[row]!;
      for (let j = 0; j < width; j++) normal[i]![j] = normal[i]![j]! + weight * x[row]![i]! * x[row]![j]!;
    }
  }
  for (let i = 1; i < width; i++) normal[i]![i] = normal[i]![i]! + 0.02;
  const tau = solve(normal, target);
  const residuals = rows.map((_, row) => residualOutcome[row]! - residualTreatment[row]! * x[row]!.reduce((sum, value, i) => sum + value * tau[i]!, 0));
  const sigmaSquared = residuals.reduce((sum, value) => sum + value * value, 0) / Math.max(1, rows.length - width);
  const covariance = inverse(normal);
  const standardError = Math.sqrt(Math.max(0, sigmaSquared * covariance[0]![0]!));
  const effect = clamp(tau[0]!, -1, 1);
  const averageGoldAt10 = rows.reduce((sum, row) => sum + row.goldAt10, 0) / rows.length;
  return {
    effect,
    standardError,
    confidenceInterval: [effect - 1.96 * standardError, effect + 1.96 * standardError],
    observations: rows.length,
    treated,
    untreated,
    averageGoldAt10,
  };
}

function fallbackInsight(estimate: CausalEstimate): string {
  const delta = (estimate.effect * 100).toFixed(1);
  const direction = estimate.effect >= 0 ? 'higher' : 'lower';
  return `Across ${estimate.observations} matches, placing a control ward before minute 5 is associated with an adjusted ${Math.abs(Number(delta)).toFixed(1)} percentage-point ${direction} win probability (95% interval ${ (estimate.confidenceInterval[0] * 100).toFixed(1)} to ${(estimate.confidenceInterval[1] * 100).toFixed(1)}). Average gold at 10 minutes was ${Math.round(estimate.averageGoldAt10)}; it was treated as a post-treatment outcome, not a confounder.`;
}

async function narrateInsight(estimate: CausalEstimate, apiKey: string, fetcher: typeof fetch): Promise<string> {
  const url = process.env.INSIGHT_LLM_URL || 'https://api.openai.com/v1/chat/completions';
  const model = process.env.INSIGHT_LLM_MODEL || 'gpt-4o';
  const response = await fetcher(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Write one cautious, player-facing causal insight sentence. Do not invent or restate numeric estimates. Do not call an association causal beyond the supplied cross-fitted estimate.' },
        { role: 'user', content: JSON.stringify({ treatment: 'control ward before minute 5', observations: estimate.observations, effect: estimate.effect, confidenceInterval: estimate.confidenceInterval, averageGoldAt10: estimate.averageGoldAt10 }) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'causal_insight_text',
          strict: true,
          schema: { type: 'object', properties: { insight: { type: 'string' } }, required: ['insight'], additionalProperties: false },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Insight LLM request failed with HTTP ${response.status}`);
  const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error('Insight LLM returned no structured message');
  const parsed = JSON.parse(content) as { insight?: unknown };
  if (typeof parsed.insight !== 'string' || !parsed.insight.trim()) throw new Error('Insight LLM returned an invalid insight');
  return parsed.insight.trim();
}

export async function generateCausalInsight(
  summonerData: SummonerData,
  options: { apiKey?: string; fetcher?: typeof fetch } = {},
): Promise<CausalInsight> {
  const estimate = estimateCATE(summonerData);
  let insight = fallbackInsight(estimate);
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (apiKey) {
    try { insight = await narrateInsight(estimate, apiKey, options.fetcher || fetch); } catch { /* The numerical estimate remains available without the narrator. */ }
  }
  return {
    insight,
    causal_delta: estimate.effect * 100,
    confidence_interval: [estimate.confidenceInterval[0] * 100, estimate.confidenceInterval[1] * 100],
  };
}