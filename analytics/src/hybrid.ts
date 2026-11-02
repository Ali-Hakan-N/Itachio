import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RiotMatchV5 } from './clickhouse.js';
import { DRAFT_FEATURE_COUNT, DRAFT_FEATURE_NAMES, type DraftHistory } from './features.js';
import { exportGbdtOnnx, gbdtLogit, trainGbdt, type GbdtModel, type GbdtOptions } from './gbdt.js';
import { buildObservations, indexMatch, makeHistory, matchTime, LANES, type Lane, type MatchSide } from './training-data.js';

// The experimental draft model: gradient boosted trees over the 58 dense features plus the
// outputs of a sparse champion layer, read at match level and backed by a prior where the
// sample is thin. Everything is split by time and by match:
//
//   prior window   builds the dense history and fits the sparse layer
//   train window   later matches, seen through that history: the trees are fitted here
//   its newest 20% early stopping, the blend strength and the calibration
//
// A match's prediction comes from its ten champion rows: the mean log-odds of blue's five
// minus red's five, halved.

/** Dense columns with no real value in historical matches; the trees may not split on them */
export const MASKED_FEATURES: ReadonlySet<string> = new Set([
  'pick_order', // Match-V5 and its timeline do not record the draft order
  'enemy_answer_share', // follows from the draft order
  'rank_tier', // only the rank at collection time is known, not at match time
  'patch_age', // a single patch at a time; later matches would sit outside the fitted range
  'candidate_range', // no measured source yet
]);
export const SPARSE_FEATURE_NAMES = ['sparse_strength', 'sparse_synergy', 'sparse_matchup', 'sparse_team_logit'] as const;
export const HYBRID_FEATURE_NAMES = [...DRAFT_FEATURE_NAMES, ...SPARSE_FEATURE_NAMES] as const;
const HYBRID_FEATURE_COUNT = HYBRID_FEATURE_NAMES.length;

const SPARSE_TAU = { c: 10, s: 300, v: 300 } as const;
const SPARSE_ITERATIONS = 80;
const SPARSE_LEARNING_RATE = 0.05;
const NO_BLEND = Infinity;
const EVIDENCE_GRID = [NO_BLEND, 800, 200, 50]; // games at which a pick has 63% of its evidence

const sigmoid = (value: number): number => 1 / (1 + Math.exp(-value));

export interface SparseLayer { bias: number; weights: Record<string, number> }

const championKey = (championId: number, lane: Lane) => `c:${championId}:${lane}`;
const synergyKey = (a: number, laneA: Lane, b: number, laneB: Lane) => (`${a}:${laneA}` < `${b}:${laneB}` ? `s:${a}:${laneA}:${b}:${laneB}` : `s:${b}:${laneB}:${a}:${laneA}`);
// One weight per same-lane pair: the first champion's side of it, the other side is its negative
const matchupKey = (a: number, b: number, lane: Lane): [string, 1 | -1] => (a < b ? [`v:${a}:${b}:${lane}`, 1] : [`v:${b}:${a}:${lane}`, -1]);

function sideTerms(side: MatchSide, sign: number, emit: (key: string, value: number) => void) {
  LANES.forEach((lane, first) => {
    const a = side.picks.get(lane)!.championId;
    emit(championKey(a, lane), sign);
    for (const other of LANES.slice(first + 1)) emit(synergyKey(a, lane, side.picks.get(other)!.championId, other), sign);
  });
}

function matchTerms(sides: Map<'blue' | 'red', MatchSide>, emit: (key: string, value: number) => void) {
  const blue = sides.get('blue')!;
  const red = sides.get('red')!;
  sideTerms(blue, 1, emit);
  sideTerms(red, -1, emit);
  for (const lane of LANES) {
    const [key, sign] = matchupKey(blue.picks.get(lane)!.championId, red.picks.get(lane)!.championId, lane);
    emit(key, sign);
  }
}

/** Logistic regression of "blue wins" over champion:lane, same-team pairs and lane matchups, by full-batch Adam */
export function fitSparseLayer(matches: readonly RiotMatchV5[]): SparseLayer {
  const index = new Map<string, number>();
  const pointers = [0];
  const columns: number[] = [];
  const values: number[] = [];
  const labels: number[] = [];
  for (const match of matches) {
    const sides = indexMatch(match);
    if (!sides) continue;
    matchTerms(sides, (key, value) => {
      let column = index.get(key);
      if (column === undefined) {
        column = index.size;
        index.set(key, column);
      }
      columns.push(column);
      values.push(value);
    });
    pointers.push(columns.length);
    labels.push(sides.get('blue')!.won);
  }
  const n = labels.length;
  if (!n) return { bias: 0, weights: {} };
  const keys = [...index.keys()];
  const penalty = Float64Array.from(keys, (key) => SPARSE_TAU[key[0] as 'c' | 's' | 'v'] / n);
  const w = new Float64Array(keys.length);
  const m1 = new Float64Array(keys.length);
  const m2 = new Float64Array(keys.length);
  const g = new Float64Array(keys.length);
  let bias = 0;
  let biasM1 = 0;
  let biasM2 = 0;
  const [b1, b2] = [0.9, 0.999];
  for (let t = 1; t <= SPARSE_ITERATIONS; t++) {
    g.fill(0);
    let biasG = 0;
    for (let r = 0; r < n; r++) {
      let z = bias;
      for (let j = pointers[r]!; j < pointers[r + 1]!; j++) z += w[columns[j]!]! * values[j]!;
      const error = sigmoid(z) - labels[r]!;
      biasG += error;
      for (let j = pointers[r]!; j < pointers[r + 1]!; j++) g[columns[j]!] = g[columns[j]!]! + error * values[j]!;
    }
    const scale1 = 1 - b1 ** t;
    const scale2 = 1 - b2 ** t;
    for (let i = 0; i < w.length; i++) {
      const grad = g[i]! / n + penalty[i]! * w[i]!;
      m1[i] = b1 * m1[i]! + (1 - b1) * grad;
      m2[i] = b2 * m2[i]! + (1 - b2) * grad * grad;
      w[i] = w[i]! - (SPARSE_LEARNING_RATE * (m1[i]! / scale1)) / (Math.sqrt(m2[i]! / scale2) + 1e-8);
    }
    const grad = biasG / n;
    biasM1 = b1 * biasM1 + (1 - b1) * grad;
    biasM2 = b2 * biasM2 + (1 - b2) * grad * grad;
    bias -= (SPARSE_LEARNING_RATE * (biasM1 / scale1)) / (Math.sqrt(biasM2 / scale2) + 1e-8);
  }
  return { bias, weights: Object.fromEntries(keys.map((key, i) => [key, w[i]!])) };
}

/** The sparse layer's view of one champion row, from that champion's team */
export function sparseFeatures(layer: SparseLayer, own: MatchSide, other: MatchSide, lane: Lane): [number, number, number, number] {
  const weight = (key: string) => layer.weights[key] ?? 0;
  const champion = own.picks.get(lane)!.championId;
  let synergy = 0;
  for (const otherLane of LANES) {
    if (otherLane !== lane) synergy += weight(synergyKey(champion, lane, own.picks.get(otherLane)!.championId, otherLane));
  }
  const [key, sign] = matchupKey(champion, other.picks.get(lane)!.championId, lane);
  let team = 0;
  matchTerms(new Map([['blue', own], ['red', other]]), (termKey, value) => { team += weight(termKey) * value; });
  // The bias belongs to blue: it is blue's side advantage, seen from red as its negative
  team += own.teamSide === 'blue' ? layer.bias : -layer.bias;
  return [weight(championKey(champion, lane)), synergy, sign * weight(key), team];
}

export interface HybridRows {
  X: Float32Array;
  y: Uint8Array;
  matchIds: string[];
  /** Per match: the ten rows start at matchStart[m], blue's five first */
  matchStart: number[];
  /** Per match: the rows' games in the history, for the evidence of the prediction */
  games: Float32Array;
  /** Per row: the championprior log-odds from the history or the given meta prior */
  prior: Float32Array;
  blueWon: Uint8Array;
}

/** Win rate per "champion:lane" from an outside source (MetaSRC), used in place of the history's */
export type MetaPrior = Readonly<Record<string, number>>;

function rowsFor(matches: readonly RiotMatchV5[], history: DraftHistory, sparse: SparseLayer, metaPrior: MetaPrior | null, rankTierByMatch?: Readonly<Record<string, string>>): HybridRows {
  const observations = buildObservations(matches, history, rankTierByMatch ? { rankTierByMatch } : {});
  const count = observations.length;
  const X = new Float32Array(count * HYBRID_FEATURE_COUNT);
  const y = new Uint8Array(count);
  const games = new Float32Array(count);
  const prior = new Float32Array(count);
  const matchIds: string[] = [];
  const matchStart: number[] = [];
  const blueWon: number[] = [];
  const byId = new Map(matches.map((match) => [match.metadata.matchId, match]));
  let row = 0;
  let sides: ReturnType<typeof indexMatch> = null;
  for (const observation of observations) {
    if (row % 10 === 0) {
      sides = indexMatch(byId.get(observation.match_id)!)!;
      matchIds.push(observation.match_id);
      matchStart.push(row);
      blueWon.push(sides.get('blue')!.won);
    }
    X.set(observation.features, row * HYBRID_FEATURE_COUNT);
    const lane = observation.lane_id;
    const own = sides!.get(observation.team_side)!;
    const other = sides!.get(observation.team_side === 'blue' ? 'red' : 'blue')!;
    X.set(sparseFeatures(sparse, own, other, lane), row * HYBRID_FEATURE_COUNT + DRAFT_FEATURE_COUNT);
    y[row] = observation.won;
    const profile = history.champions[`${observation.champion_id}:${lane}`];
    games[row] = profile?.games ?? 0;
    const rate = Math.min(0.7, Math.max(0.3, metaPrior?.[`${observation.champion_id}:${lane}`] ?? profile?.winRate ?? 0.5));
    prior[row] = Math.log(rate / (1 - rate));
    row++;
  }
  return { X, y, matchIds, matchStart, games, prior, blueWon: Uint8Array.from(blueWon) };
}

/** The ten rows of a match, in the order buildObservations gives: blue's five, then red's */
function matchParts(rows: HybridRows, model: GbdtModel, match: number) {
  const start = rows.matchStart[match]!;
  let modelLogit = 0;
  let priorLogit = 0;
  const evidenceGames: number[] = [];
  for (let i = 0; i < 10; i++) {
    const sign = i < 5 ? 1 : -1;
    modelLogit += sign * gbdtLogit(model, rows.X, start + i);
    priorLogit += sign * rows.prior[start + i]!;
    evidenceGames.push(rows.games[start + i]!);
  }
  return { modelLogit: modelLogit / 10, priorLogit: priorLogit / 2, evidenceGames };
}

/** Share of the prediction that is the model's: the mean evidence of the ten picks */
function modelShare(games: readonly number[], evidenceK: number): number {
  if (evidenceK === NO_BLEND) return 1;
  return games.reduce((sum, value) => sum + (1 - Math.exp(-value / evidenceK)), 0) / games.length;
}

const logLossOf = (label: number, logit: number): number => {
  const probability = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(logit)));
  return -(label ? Math.log(probability) : Math.log(1 - probability));
};

/** Platt scaling by Newton steps */
function fitCalibration(logits: readonly number[], labels: ArrayLike<number>): { a: number; b: number } {
  let a = 1;
  let b = 0;
  for (let iteration = 0; iteration < 30; iteration++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    logits.forEach((z, i) => {
      const p = sigmoid(a * z + b);
      const e = p - labels[i]!;
      const w = p * (1 - p);
      ga += e * z; gb += e; haa += w * z * z; hab += w * z; hbb += w;
    });
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-12) break;
    a -= (hbb * ga - hab * gb) / det;
    b -= (haa * gb - hab * ga) / det;
  }
  return { a: Math.min(2, Math.max(0.1, a)), b };
}

export interface HybridOptions {
  /** Share of the matches used to build the history and the sparse layer */
  priorShare?: number;
  maxTrainMatches?: number;
  gbdt?: GbdtOptions;
  metaPrior?: MetaPrior | null;
  rankTierByMatch?: Readonly<Record<string, string>>;
  log?: (line: string) => void;
}

export interface HybridModel {
  version: 2;
  featureNames: readonly string[];
  gbdt: GbdtModel;
  sparse: SparseLayer;
  /** Games at which a pick has 63% of its evidence; null means no blend with the prior */
  evidenceK: number | null;
  calibration: { a: number; b: number };
  trainedAt: string;
  priorMatches: number;
  trainMatches: number;
  validationLogLoss: number;
  validationAccuracy: number;
}

export interface FittedHybrid {
  model: HybridModel;
  history: DraftHistory;
  /** Log-odds that blue wins, for later matches. Skips what indexMatch rejects */
  predict(matches: readonly RiotMatchV5[]): Map<string, number>;
}

/** matches: oldest first. See the top of this file for the windows */
export function trainHybrid(matches: readonly RiotMatchV5[], options: HybridOptions = {}): FittedHybrid {
  const log = options.log ?? (() => {});
  const priorShare = options.priorShare ?? 0.7;
  const split = Math.floor(matches.length * priorShare);
  const priorMatches = matches.slice(0, split);
  const trainMatches = matches.slice(split).slice(-(options.maxTrainMatches ?? 30_000));
  if (priorMatches.length < 100 || trainMatches.length < 50) throw new Error('Too few matches for the prior and train windows');
  const history = makeHistory(priorMatches);
  const sparse = fitSparseLayer(priorMatches);
  log(`hybrid: history and sparse layer from ${priorMatches.length} matches (${Object.keys(sparse.weights).length} weights)`);
  const metaPrior = options.metaPrior ?? null;
  const rows = rowsFor(trainMatches, history, sparse, metaPrior, options.rankTierByMatch);
  const matchCount = rows.matchIds.length;
  const validFrom = Math.floor(matchCount * 0.8);
  const rowsOf = (from: number, to: number) => {
    const out = new Int32Array((to - from) * 10);
    for (let match = from; match < to; match++) for (let i = 0; i < 10; i++) out[(match - from) * 10 + i] = rows.matchStart[match]! + i;
    return out;
  };
  const excluded = new Set(HYBRID_FEATURE_NAMES.flatMap((name, column) => (MASKED_FEATURES.has(name) && !(name === 'rank_tier' && options.rankTierByMatch) ? [column] : [])));
  const gbdt = trainGbdt(rows.X, rows.y, HYBRID_FEATURE_COUNT, rowsOf(0, validFrom), rowsOf(validFrom, matchCount), { excluded, ...options.gbdt });
  log(`hybrid: ${gbdt.trees.length} trees, held-out row logloss ${gbdt.validationLogLoss.toFixed(5)}`);

  const parts = Array.from({ length: matchCount - validFrom }, (_, i) => matchParts(rows, gbdt, validFrom + i));
  const labels = rows.blueWon.subarray(validFrom);
  let chosen = { evidenceK: NO_BLEND, calibration: { a: 1, b: 0 }, loss: Infinity, accuracy: 0 };
  for (const evidenceK of EVIDENCE_GRID) {
    const blended = parts.map((part) => {
      const share = modelShare(part.evidenceGames, evidenceK);
      return share * part.modelLogit + (1 - share) * part.priorLogit;
    });
    const calibration = fitCalibration(blended, labels);
    const scored = blended.map((z) => calibration.a * z + calibration.b);
    const loss = scored.reduce((sum, z, i) => sum + logLossOf(labels[i]!, z), 0) / scored.length;
    const accuracy = scored.reduce((sum, z, i) => sum + (Number(z >= 0) === labels[i]! ? 1 : 0), 0) / scored.length;
    log(`hybrid: evidence k ${evidenceK === NO_BLEND ? 'none' : evidenceK}: match logloss ${loss.toFixed(5)}`);
    if (loss < chosen.loss) chosen = { evidenceK, calibration, loss, accuracy };
  }

  const model: HybridModel = {
    version: 2,
    featureNames: HYBRID_FEATURE_NAMES,
    gbdt,
    sparse,
    evidenceK: chosen.evidenceK === NO_BLEND ? null : chosen.evidenceK,
    calibration: chosen.calibration,
    trainedAt: new Date().toISOString(),
    priorMatches: priorMatches.length,
    trainMatches: trainMatches.length,
    validationLogLoss: chosen.loss,
    validationAccuracy: chosen.accuracy,
  };
  return {
    model,
    history,
    predict(later) {
      const laterRows = rowsFor(later, history, sparse, metaPrior, options.rankTierByMatch);
      const out = new Map<string, number>();
      laterRows.matchIds.forEach((id, match) => {
        const part = matchParts(laterRows, gbdt, match);
        const share = modelShare(part.evidenceGames, chosen.evidenceK);
        out.set(id, chosen.calibration.a * (share * part.modelLogit + (1 - share) * part.priorLogit) + chosen.calibration.b);
      });
      return out;
    },
  };
}

export async function saveHybrid(model: HybridModel, onnxPath: string): Promise<void> {
  await mkdir(dirname(onnxPath), { recursive: true });
  await Promise.all([
    exportGbdtOnnx(model.gbdt, onnxPath),
    writeFile(onnxPath.replace(/\.onnx$/i, '.json'), `${JSON.stringify(model)}\n`, 'utf8'),
  ]);
}

// ---------------- Head-to-head backtest ----------------

export interface HeadToHeadResult {
  matches: number;
  candidateLogLoss: number;
  productionLogLoss: number;
  baselineLogLoss: number;
  candidateAccuracy: number;
  productionAccuracy: number;
  /** Production logloss minus the candidate's, paired over matches; positive favors the candidate */
  gain: number;
  se: number;
  /** The candidate replaces production only if gain > 2 × se */
  passed: boolean;
}

/** Paired comparison on the same matches. labels: 1 when blue won; both maps give blue's log-odds */
export function headToHead(labels: ReadonlyMap<string, number>, candidate: ReadonlyMap<string, number>, production: ReadonlyMap<string, number>, baselineLogit = 0): HeadToHeadResult {
  let sum = 0, square = 0, n = 0;
  let candidateLoss = 0, productionLoss = 0, baselineLoss = 0, candidateHits = 0, productionHits = 0;
  for (const [id, label] of labels) {
    const c = candidate.get(id);
    const p = production.get(id);
    if (c === undefined || p === undefined) continue;
    const lossC = logLossOf(label, c);
    const lossP = logLossOf(label, p);
    candidateLoss += lossC;
    productionLoss += lossP;
    baselineLoss += logLossOf(label, baselineLogit);
    candidateHits += Number(c >= 0) === label ? 1 : 0;
    productionHits += Number(p >= 0) === label ? 1 : 0;
    const d = lossP - lossC;
    sum += d;
    square += d * d;
    n++;
  }
  if (!n) throw new Error('No matches in common');
  const gain = sum / n;
  const se = Math.sqrt(Math.max(square / n - gain * gain, 0) / n);
  return {
    matches: n,
    candidateLogLoss: candidateLoss / n,
    productionLogLoss: productionLoss / n,
    baselineLogLoss: baselineLoss / n,
    candidateAccuracy: candidateHits / n,
    productionAccuracy: productionHits / n,
    gain,
    se,
    passed: gain > 2 * se,
  };
}

/**
 * Oldest first: matches with no start time (they predate the field), then by start time.
 * The test window is the newest testShare of the matches with a start time; nothing of it
 * reaches a model fitted on `development`.
 */
export function chronologicalSplit<T extends RiotMatchV5>(matches: readonly T[], testShare = 0.3): { development: T[]; test: T[] } {
  const timed = matches.filter((match) => matchTime(match) > 0).sort((a, b) => matchTime(a) - matchTime(b));
  const untimed = matches.filter((match) => matchTime(match) <= 0);
  const cut = Math.floor(timed.length * (1 - testShare));
  return { development: [...untimed, ...timed.slice(0, cut)], test: timed.slice(cut) };
}
