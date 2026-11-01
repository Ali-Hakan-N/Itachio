export const DRAFT_FEATURE_NAMES = [
  'candidate_win_rate', 'candidate_patch_win_rate', 'candidate_lane_win_rate', 'candidate_role_share',
  'candidate_pick_rate', 'candidate_ban_rate', 'candidate_sample_confidence', 'candidate_uncertainty',
  'candidate_blind_spread', 'candidate_counter_rate', 'candidate_counter_chance', 'candidate_scaling',
  'candidate_damage_ap', 'candidate_damage_ad', 'candidate_damage_true', 'candidate_cc',
  'candidate_frontline', 'candidate_sustain', 'candidate_range', 'candidate_engage',
  'matchup_win_rate', 'matchup_coverage', 'matchup_sample_confidence', 'synergy_average',
  'synergy_best', 'synergy_worst', 'synergy_coverage', 'synergy_sample_confidence',
  'ally_damage_ap', 'ally_damage_ad', 'ally_damage_true', 'ally_damage_imbalance',
  'enemy_damage_ap', 'enemy_damage_ad', 'enemy_damage_true', 'enemy_damage_imbalance',
  'damage_ap_delta', 'damage_ad_delta', 'damage_true_delta', 'ally_cc', 'enemy_cc', 'cc_delta',
  'ally_frontline', 'enemy_frontline', 'frontline_delta', 'ally_sustain', 'enemy_sustain', 'sustain_delta',
  'ally_scaling', 'enemy_scaling', 'scaling_delta', 'ally_pick_count', 'enemy_pick_count',
  'net_ban_count', 'pick_order', 'enemy_answer_share', 'patch_age', 'rank_tier',
] as const;

export const DRAFT_FEATURE_COUNT = 58;

if (DRAFT_FEATURE_NAMES.length !== DRAFT_FEATURE_COUNT) {
  throw new Error(`Draft feature schema has ${DRAFT_FEATURE_NAMES.length} features, expected ${DRAFT_FEATURE_COUNT}`);
}

export type TeamSide = 'blue' | 'red';
export type LaneId = 'TOP' | 'JNG' | 'MID' | 'ADC' | 'SUP';
export type DamageProfile = readonly [ap: number, ad: number, trueDamage: number];

export interface ChampionProfile {
  games: number;
  wins: number;
  winRate?: number;
  patchWinRate?: number;
  laneWinRate?: number;
  roleShare: number;
  pickRate: number;
  banRate: number;
  uncertainty: number;
  blindSpread: number;
  counterRate: number;
  counterChance: number;
  scaling: number;
  damage: DamageProfile;
  cc: number;
  frontline: number;
  sustain: number;
  range: number;
  engage: number;
}

export interface PairProfile {
  games: number;
  wins: number;
  strength?: number;
  winRate?: number;
}

export interface DraftPick {
  championId: number;
  laneId?: LaneId;
}

export interface DraftHistory {
  champions: Readonly<Record<string, ChampionProfile>>;
  matchups: Readonly<Record<string, PairProfile>>;
  synergies: Readonly<Record<string, PairProfile>>;
}

export interface DraftFeatureInput {
  championId: number;
  teamSide: TeamSide;
  laneId: LaneId;
  allies: readonly DraftPick[];
  enemies: readonly DraftPick[];
  allyBans?: readonly number[];
  enemyBans?: readonly number[];
  history: DraftHistory;
  queueId: 420 | 440;
  rankTier: number;
  pickOrder: number;
  enemyAnswerShare: number;
  patchAge: number;
  rankTierName?: string;
}

export interface DraftStateVector {
  match_id: string;
  champion_id: number;
  team_side: TeamSide;
  lane_id: LaneId;
  base_winrate: number;
  matchup_winrate: number;
  synergy_score: number;
  damage_profile: DamageProfile;
  cc_score: number;
  features: number[];
  won: 0 | 1;
  patch: string;
  queue_id: 420 | 440;
  rank_tier: string;
}

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
const mean = (values: readonly number[], fallback = 0): number => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
const sampleConfidence = (games: number): number => Math.max(0, games) / (Math.max(0, games) + 100);
const imbalance = ([ap, ad]: DamageProfile): number => Math.abs(ap - ad);

function profileFor(history: DraftHistory, pick: DraftPick): ChampionProfile | undefined {
  const lane = pick.laneId;
  return lane ? history.champions[`${pick.championId}:${lane}`] : undefined;
}

function effectiveWinRate(pair: PairProfile | undefined, fallback = 0.5): number {
  if (!pair) return fallback;
  if (Number.isFinite(pair.winRate)) return clamp(pair.winRate as number);
  return pair.games > 0 ? clamp(pair.wins / pair.games) : fallback;
}

function pairKey(a: DraftPick, b: DraftPick): string {
  return `${a.championId}:${a.laneId || ''}:${b.championId}:${b.laneId || ''}`;
}

function teamDamage(picks: readonly DraftPick[], history: DraftHistory): DamageProfile {
  const damage = picks.map((pick) => profileFor(history, pick)?.damage).filter((entry): entry is DamageProfile => Boolean(entry));
  let ap = 0;
  let ad = 0;
  let trueDamage = 0;
  for (const entry of damage) {
    ap += Math.max(0, entry[0]);
    ad += Math.max(0, entry[1]);
    trueDamage += Math.max(0, entry[2]);
  }
  const total = ap + ad + trueDamage;
  return total > 0 ? [ap / total, ad / total, trueDamage / total] : [0, 0, 0];
}

function teamMean(picks: readonly DraftPick[], history: DraftHistory, field: 'cc' | 'frontline' | 'sustain' | 'scaling'): number {
  return mean(picks.map((pick) => profileFor(history, pick)?.[field] || 0));
}

function normalizeFeatures(values: number[]): number[] {
  if (values.length !== DRAFT_FEATURE_COUNT) throw new Error(`Expected ${DRAFT_FEATURE_COUNT} draft features, received ${values.length}`);
  return values.map((value) => Number.isFinite(value) ? value : 0);
}

export function buildDraftStateVector(input: DraftFeatureInput, target: { matchId: string; patch: string; won: 0 | 1 }): DraftStateVector {
  const { history, championId, laneId } = input;
  const candidatePick: DraftPick = { championId, laneId };
  const candidate = history.champions[`${championId}:${laneId}`];
  const allies = [...input.allies.filter((pick) => pick.championId !== championId), candidatePick];
  const enemies = [...input.enemies];
  const ownPicks = input.teamSide === 'blue' ? allies : enemies;
  const otherPicks = input.teamSide === 'blue' ? enemies : allies;
  const allyDamage = teamDamage(ownPicks, history);
  const enemyDamage = teamDamage(otherPicks, history);
  const matchupEntries = enemies.map((enemy) => {
    const pair = history.matchups[pairKey(candidatePick, enemy)];
    return { rate: effectiveWinRate(pair), pair };
  });
  const synergyEntries = input.allies.filter((ally) => ally.championId !== championId).map((ally) => {
    const pair = history.synergies[pairKey(candidatePick, ally)];
    return { strength: Number.isFinite(pair?.strength) ? pair!.strength! : effectiveWinRate(pair) - 0.5, pair };
  });
  const matchupWinRate = mean(matchupEntries.map((entry) => entry.rate), 0.5);
  const synergyScore = mean(synergyEntries.map((entry) => entry.strength));
  const allyDamageImbalance = imbalance(allyDamage);
  const enemyDamageImbalance = imbalance(enemyDamage);
  const averageGames = (entries: readonly { pair: PairProfile | undefined }[]) => mean(entries.map((entry) => sampleConfidence(entry.pair?.games || 0)));
  const baseWinRate = clamp(candidate?.winRate ?? 0.5);
  const features = normalizeFeatures([
    baseWinRate,
    clamp(candidate?.patchWinRate ?? baseWinRate),
    clamp(candidate?.laneWinRate ?? baseWinRate),
    clamp(candidate?.roleShare || 0),
    clamp(candidate?.pickRate || 0),
    clamp(candidate?.banRate || 0),
    sampleConfidence(candidate?.games || 0),
    Math.max(0, candidate?.uncertainty || 0),
    Math.max(0, candidate?.blindSpread || 0),
    clamp(candidate?.counterRate || 0),
    clamp(candidate?.counterChance || 0),
    clamp(candidate?.scaling ?? 0.5),
    ...[0, 1, 2].map((i) => clamp(candidate?.damage[i] || 0)),
    Math.max(0, candidate?.cc || 0),
    clamp(candidate?.frontline || 0),
    clamp(candidate?.sustain || 0),
    clamp(candidate?.range || 0),
    clamp(candidate?.engage || 0),
    matchupWinRate,
    enemies.length ? matchupEntries.filter((entry) => entry.pair).length / enemies.length : 0,
    averageGames(matchupEntries),
    synergyScore,
    Math.max(0, ...synergyEntries.map((entry) => entry.strength)),
    Math.min(0, ...synergyEntries.map((entry) => entry.strength)),
    input.allies.length ? synergyEntries.filter((entry) => entry.pair).length / input.allies.length : 0,
    averageGames(synergyEntries),
    ...allyDamage,
    allyDamageImbalance,
    ...enemyDamage,
    enemyDamageImbalance,
    allyDamage[0] - enemyDamage[0],
    allyDamage[1] - enemyDamage[1],
    allyDamage[2] - enemyDamage[2],
    teamMean(ownPicks, history, 'cc'),
    teamMean(otherPicks, history, 'cc'),
    teamMean(ownPicks, history, 'cc') - teamMean(otherPicks, history, 'cc'),
    teamMean(ownPicks, history, 'frontline'),
    teamMean(otherPicks, history, 'frontline'),
    teamMean(ownPicks, history, 'frontline') - teamMean(otherPicks, history, 'frontline'),
    teamMean(ownPicks, history, 'sustain'),
    teamMean(otherPicks, history, 'sustain'),
    teamMean(ownPicks, history, 'sustain') - teamMean(otherPicks, history, 'sustain'),
    teamMean(ownPicks, history, 'scaling'),
    teamMean(otherPicks, history, 'scaling'),
    teamMean(ownPicks, history, 'scaling') - teamMean(otherPicks, history, 'scaling'),
    ownPicks.length / 5,
    otherPicks.length / 5,
    (input.allyBans?.length || 0) - (input.enemyBans?.length || 0),
    clamp(input.pickOrder / 9),
    clamp(input.enemyAnswerShare),
    clamp(input.patchAge / 12),
    clamp(input.rankTier / 6),
  ]);
  return {
    match_id: target.matchId,
    champion_id: championId,
    team_side: input.teamSide,
    lane_id: laneId,
    base_winrate: baseWinRate,
    matchup_winrate: matchupWinRate,
    synergy_score: synergyScore,
    damage_profile: candidate?.damage || [0, 0, 0],
    cc_score: candidate?.cc || 0,
    features,
    won: target.won,
    patch: target.patch,
    queue_id: input.queueId,
    rank_tier: input.rankTierName?.toUpperCase() || 'UNKNOWN',
  };
}

export function validateDraftStateVector(row: DraftStateVector): void {
  if (!Number.isInteger(row.champion_id) || row.champion_id < 0 || row.champion_id > 32767) throw new Error('champion_id must fit Int16');
  if (row.features.length !== DRAFT_FEATURE_COUNT) throw new Error(`features must contain exactly ${DRAFT_FEATURE_COUNT} values`);
  if (row.features.some((value) => !Number.isFinite(value))) throw new Error('features must all be finite numbers');
}