import { buildDraftStateVector, type ChampionProfile, type DraftHistory, type DraftPick, type PairProfile } from './features.js';
import type { RiotMatchV5 } from './clickhouse.js';

export const LANES = ['TOP', 'JNG', 'MID', 'ADC', 'SUP'] as const;
export type Lane = (typeof LANES)[number];
const RIOT_LANES: Record<string, (typeof LANES)[number]> = {
  TOP: 'TOP',
  JUNGLE: 'JNG',
  MIDDLE: 'MID',
  BOTTOM: 'ADC',
  UTILITY: 'SUP',
};
const RANK_CODE: Readonly<Record<string, number>> = {
  IRON: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4, EMERALD: 5, DIAMOND: 6, MASTER: 6, GRANDMASTER: 6, CHALLENGER: 6,
};

export interface MatchSide {
  teamSide: 'blue' | 'red';
  won: 0 | 1;
  picks: Map<(typeof LANES)[number], RiotMatchV5['info']['participants'][number]>;
  bans: number[];
}

interface ChampionAccumulator {
  games: number;
  factGames: number;
  wins: number;
  longGames: number;
  longWins: number;
  roleGames: number;
  magic: number;
  physical: number;
  trueDamage: number;
  cc: number;
  damageTaken: number;
  damageDealt: number;
  healing: number;
}

interface PairAccumulator { games: number; wins: number }

function patchFromMatch(match: RiotMatchV5): string {
  const parsed = /^(\d+)\.(\d+)/.exec(match.info.gameVersion);
  if (!parsed) throw new Error(`Invalid Riot gameVersion: ${match.info.gameVersion}`);
  return `${parsed[1]}.${parsed[2]}`;
}

export function indexMatch(match: RiotMatchV5): Map<'blue' | 'red', MatchSide> | null {
  if (![420, 440].includes(match.info.queueId) || match.info.participants.length !== 10) return null;
  const sides = new Map<'blue' | 'red', MatchSide>([
    ['blue', { teamSide: 'blue', won: 0, picks: new Map(), bans: [] }],
    ['red', { teamSide: 'red', won: 0, picks: new Map(), bans: [] }],
  ]);
  for (const team of match.info.teams) {
    const side = team.teamId === 100 ? 'blue' : 'red';
    const indexed = sides.get(side)!;
    indexed.won = Number(team.win) as 0 | 1;
    indexed.bans = (team.bans || []).map((ban) => ban.championId).filter((championId) => championId > 0);
  }
  for (const participant of match.info.participants) {
    const side = participant.teamId === 100 ? 'blue' : 'red';
    const lane = RIOT_LANES[participant.teamPosition || ''];
    if (!lane || sides.get(side)!.picks.has(lane)) return null;
    sides.get(side)!.picks.set(lane, participant);
  }
  return [...sides.values()].every((side) => side.picks.size === 5) ? sides : null;
}

function newChampion(): ChampionAccumulator {
  return { games: 0, factGames: 0, wins: 0, longGames: 0, longWins: 0, roleGames: 0, magic: 0, physical: 0, trueDamage: 0, cc: 0, damageTaken: 0, damageDealt: 0, healing: 0 };
}

function updatePair(store: Map<string, PairAccumulator>, key: string, won: boolean): void {
  const value = store.get(key) || { games: 0, wins: 0 };
  value.games++;
  value.wins += Number(won);
  store.set(key, value);
}

export const matchTime = (match: RiotMatchV5): number => match.info.gameStartTimestamp || match.info.gameCreation || 0;

const logit = (rate: number): number => Math.log(rate / (1 - rate));
const BLIND_COUNTER_THRESHOLD = 0.02; // a matchup this much below the odds counts as a counter
const BLIND_POOL_SIZE = 7;
const BLIND_PAIR_PRIOR = 20; // games before a pair moves away from what the two champions' rates expect
const SCALING_PRIOR = 10;

/**
 * Lane matchup spread of every champion: blindSpread (pick-weighted spread of the matchups
 * around the odds), counterRate (pick-weighted share of real counters) and counterChance (that
 * a pool of BLIND_POOL_SIZE opponents holds one). Written into the given profiles.
 */
function addBlindness(champions: Record<string, ChampionProfile>, matchups: ReadonlyMap<string, PairAccumulator>) {
  const byLane = new Map<string, Array<{ championId: string; profile: ChampionProfile }>>();
  for (const [key, profile] of Object.entries(champions)) {
    const [championId, lane] = key.split(':') as [string, string];
    const list = byLane.get(lane) || [];
    list.push({ championId, profile });
    byLane.set(lane, list);
  }
  for (const [lane, list] of byLane) {
    const totalPick = list.reduce((sum, entry) => sum + entry.profile.pickRate, 0) || 1;
    for (const { championId, profile } of list) {
      let mean = 0, square = 0, counter = 0, weightTotal = 0;
      for (const opponent of list) {
        if (opponent.championId === championId) continue;
        const weight = opponent.profile.pickRate / totalPick;
        const pair = matchups.get(`${championId}:${lane}:${opponent.championId}:${lane}`);
        const expected = 1 / (1 + Math.exp(logit(opponent.profile.winRate!) - logit(profile.winRate!)));
        const residual = pair ? (pair.wins + BLIND_PAIR_PRIOR * expected) / (pair.games + BLIND_PAIR_PRIOR) - expected : 0;
        weightTotal += weight;
        mean += weight * residual;
        square += weight * residual * residual;
        if (residual <= -BLIND_COUNTER_THRESHOLD) counter += weight;
      }
      if (!weightTotal) continue;
      mean /= weightTotal;
      profile.blindSpread = Math.sqrt(Math.max(0, square / weightTotal - mean * mean));
      profile.counterRate = counter / weightTotal;
      profile.counterChance = 1 - (1 - profile.counterRate) ** BLIND_POOL_SIZE;
    }
  }
}

export function makeHistory(matches: readonly RiotMatchV5[]): DraftHistory {
  const champions = new Map<string, ChampionAccumulator>();
  const globalGames = new Map<number, number>();
  const lanePicks = new Map<(typeof LANES)[number], number>();
  const bans = new Map<number, number>();
  const matchups = new Map<string, PairAccumulator>();
  const synergies = new Map<string, PairAccumulator>();
  let validMatches = 0;

  for (const match of matches) {
    const sides = indexMatch(match);
    if (!sides) continue;
    validMatches++;
    for (const side of sides.values()) {
      for (const championId of side.bans) bans.set(championId, (bans.get(championId) || 0) + 1);
      for (const lane of LANES) {
        const participant = side.picks.get(lane)!;
        const key = `${participant.championId}:${lane}`;
        const profile = champions.get(key) || newChampion();
        const won = participant.win;
        const duration = match.info.gameDuration;
        const damage = [participant.magicDamageDealtToChampions || 0, participant.physicalDamageDealtToChampions || 0, participant.trueDamageDealtToChampions || 0];
        const damageSum = damage.reduce((sum, value) => sum + value, 0);
        const damageTotal = damageSum || 1;
        profile.games++;
        profile.roleGames++;
        profile.wins += Number(won);
        if (duration >= 1800) { profile.longGames++; profile.longWins += Number(won); }
        // Older matches have no player numbers: the profiles are averages over those that do
        if (damageSum) {
          profile.factGames++;
          profile.magic += damage[0]! / damageTotal;
          profile.physical += damage[1]! / damageTotal;
          profile.trueDamage += damage[2]! / damageTotal;
          profile.cc += participant.timeCCingOthers || participant.totalTimeCCDealt || 0;
          profile.damageTaken += participant.totalDamageTaken || 0;
          profile.damageDealt += damageTotal;
          profile.healing += participant.totalHeal || 0;
        }
        champions.set(key, profile);
        globalGames.set(participant.championId, (globalGames.get(participant.championId) || 0) + 1);
        lanePicks.set(lane, (lanePicks.get(lane) || 0) + 1);
      }
      for (let first = 0; first < LANES.length; first++) for (let second = first + 1; second < LANES.length; second++) {
        const firstLane = LANES[first]!;
        const secondLane = LANES[second]!;
        const a = side.picks.get(firstLane)!;
        const b = side.picks.get(secondLane)!;
        updatePair(synergies, `${a.championId}:${firstLane}:${b.championId}:${secondLane}`, side.won === 1);
        updatePair(synergies, `${b.championId}:${secondLane}:${a.championId}:${firstLane}`, side.won === 1);
      }
    }
    const blue = sides.get('blue')!;
    const red = sides.get('red')!;
    for (const lane of LANES) {
      const b = blue.picks.get(lane)!;
      const r = red.picks.get(lane)!;
      updatePair(matchups, `${b.championId}:${lane}:${r.championId}:${lane}`, blue.won === 1);
      updatePair(matchups, `${r.championId}:${lane}:${b.championId}:${lane}`, red.won === 1);
    }
  }

  const championProfiles: Record<string, ChampionProfile> = {};
  for (const [key, profile] of champions) {
    const [championText] = key.split(':');
    const championId = Number(championText);
    const gameCount = profile.games;
    const total = profile.magic + profile.physical + profile.trueDamage || 1;
    const baseWinRate = (profile.wins + 0.5) / (gameCount + 1);
    const lateWinRate = (profile.longWins + SCALING_PRIOR * baseWinRate) / (profile.longGames + SCALING_PRIOR);
    const factGames = Math.max(1, profile.factGames);
    const allRoleGames = globalGames.get(championId) || gameCount;
    championProfiles[key] = {
      games: gameCount,
      wins: profile.wins,
      winRate: baseWinRate,
      patchWinRate: baseWinRate,
      laneWinRate: baseWinRate,
      roleShare: gameCount / allRoleGames,
      pickRate: gameCount / Math.max(1, lanePicks.get(key.split(':')[1] as (typeof LANES)[number]) || gameCount),
      banRate: (bans.get(championId) || 0) / Math.max(1, validMatches),
      uncertainty: Math.sqrt(baseWinRate * (1 - baseWinRate) / (gameCount + 1)),
      blindSpread: 0,
      counterRate: 0,
      counterChance: 0,
      scaling: lateWinRate - baseWinRate,
      damage: [profile.magic / total, profile.physical / total, profile.trueDamage / total],
      cc: profile.cc / factGames,
      frontline: profile.damageTaken / Math.max(1, profile.damageTaken + profile.damageDealt),
      sustain: 1 - Math.exp(-profile.healing / (factGames * 10000)),
      range: 0.5,
      engage: Math.min(1, profile.cc / (factGames * 20)),
    };
  }
  addBlindness(championProfiles, matchups);
  const pairProfiles = (source: Map<string, PairAccumulator>, kind: 'synergy' | 'matchup'): Record<string, PairProfile> => {
    const out: Record<string, PairProfile> = {};
    for (const [key, pair] of source) {
      const [championId, lane] = key.split(':');
      const base = championProfiles[`${championId}:${lane}`]?.winRate ?? 0.5;
      const pairRate = (pair.wins + 0.5) / (pair.games + 1);
      out[key] = { games: pair.games, wins: pair.wins, winRate: pairRate, ...(kind === 'synergy' ? { strength: pairRate - base } : {}) };
    }
    return out;
  };
  return {
    champions: championProfiles,
    matchups: pairProfiles(matchups, 'matchup'),
    synergies: pairProfiles(synergies, 'synergy'),
  };
}

export interface TrainingDataOptions {
  priorFraction?: number;
  minimumPriorMatches?: number;
  maxFutureMatches?: number;
  rankTierByMatch?: Readonly<Record<string, string>>;
}

export function buildTrainingObservations(matches: readonly RiotMatchV5[], options: TrainingDataOptions = {}) {
  const ordered = [...matches].sort((a, b) => matchTime(a) - matchTime(b));
  const priorFraction = options.priorFraction ?? 0.7;
  if (!(priorFraction > 0 && priorFraction < 1)) throw new Error('priorFraction must be between 0 and 1');
  const split = Math.floor(ordered.length * priorFraction);
  if (split < (options.minimumPriorMatches ?? 500)) throw new Error('Insufficient historical matches to calculate training features');
  const prior = ordered.slice(0, split);
  const future = ordered.slice(split);
  const selectedFuture = options.maxFutureMatches && options.maxFutureMatches > 0
    ? future.slice(-options.maxFutureMatches)
    : future;
  return buildObservations(selectedFuture, makeHistory(prior), options);
}

/** Ten labeled rows per match: blue's five, then red's, in lane order */
export function buildObservations(matches: readonly RiotMatchV5[], history: DraftHistory, options: Pick<TrainingDataOptions, 'rankTierByMatch'> = {}) {
  const observations: ReturnType<typeof buildDraftStateVector>[] = [];

  for (const match of matches) {
    const sides = indexMatch(match);
    if (!sides) continue;
    const patch = patchFromMatch(match);
    const rankTierName = options.rankTierByMatch?.[match.metadata.matchId]?.toUpperCase() || 'UNKNOWN';
    const bans = { blue: sides.get('blue')!.bans, red: sides.get('red')!.bans };
    for (const side of sides.values()) {
      const opposing = sides.get(side.teamSide === 'blue' ? 'red' : 'blue')!;
      for (const lane of LANES) {
        const participant = side.picks.get(lane)!;
        const allies: DraftPick[] = [...side.picks].filter(([otherLane]) => otherLane !== lane).map(([otherLane, pick]) => ({ championId: pick.championId, laneId: otherLane }));
        const enemies: DraftPick[] = [...opposing.picks].map(([enemyLane, pick]) => ({ championId: pick.championId, laneId: enemyLane }));
        observations.push(buildDraftStateVector({
          championId: participant.championId,
          teamSide: side.teamSide,
          laneId: lane,
          allies,
          enemies,
          allyBans: bans[side.teamSide],
          enemyBans: bans[opposing.teamSide],
          history,
          queueId: match.info.queueId as 420 | 440,
          rankTier: RANK_CODE[rankTierName] ?? 3,
          rankTierName,
          pickOrder: 0,
          enemyAnswerShare: 1,
          patchAge: 0,
        }, { matchId: match.metadata.matchId, patch, won: Number(participant.win) as 0 | 1 }));
      }
    }
  }
  return observations;
}

export interface CompactMatch {
  id: string;
  q: 420 | 440;
  w: 0 | 1;
  b: number[];
  r: number[];
  patch?: string;
  t?: number;
  d?: number;
  xb?: Array<[magic: number, physical: number, healing: number, cc: number, taken?: number] | null>;
  xr?: Array<[magic: number, physical: number, healing: number, cc: number, taken?: number] | null>;
  /** Banned champions of both teams, blue's first; -1 (no ban) is left out, so the split is approximate */
  x?: number[];
}

export function isCompactMatch(value: unknown, patchFallback?: string): value is CompactMatch {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CompactMatch>;
  return typeof row.id === 'string'
    && (row.q === 420 || row.q === 440)
    && (row.w === 0 || row.w === 1)
    && Array.isArray(row.b) && row.b.length === 5 && row.b.every((id) => Number.isInteger(id) && id > 0)
    && Array.isArray(row.r) && row.r.length === 5 && row.r.every((id) => Number.isInteger(id) && id > 0)
    && typeof (row.patch || patchFallback) === 'string' && /^\d+\.\d+$/.test(row.patch || patchFallback || '');
}

const COMPACT_ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;

export function compactMatchToRiotMatch(match: CompactMatch, patchFallback?: string): RiotMatchV5 {
  if (match.b.length !== 5 || match.r.length !== 5 || match.b.some((id) => !id) || match.r.some((id) => !id)) {
    throw new Error(`Compact match ${match.id} must contain five champion ids for both sides`);
  }
  const patch = match.patch || patchFallback;
  if (!patch || !/^\d+\.\d+$/.test(patch)) throw new Error(`Compact match ${match.id} has no valid patch`);
  const participants = [...match.b.map((championId, role) => ({ championId, teamId: 100, role, facts: match.xb?.[role] })),
    ...match.r.map((championId, role) => ({ championId, teamId: 200, role, facts: match.xr?.[role] }))]
    .map(({ championId, teamId, role, facts }) => ({
      championId,
      teamId,
      teamPosition: COMPACT_ROLES[role]!,
      win: teamId === 100 ? match.w === 1 : match.w === 0,
      magicDamageDealtToChampions: facts?.[0] || 0,
      physicalDamageDealtToChampions: facts?.[1] || 0,
      totalHeal: facts?.[2] || 0,
      timeCCingOthers: facts?.[3] || 0,
      totalDamageTaken: facts?.[4] || 0,
    }));
  const bans = (match.x || []).map((championId) => ({ championId }));
  const half = Math.ceil(bans.length / 2);
  return {
    metadata: { matchId: match.id },
    info: {
      queueId: match.q,
      gameVersion: `${patch}.1`,
      ...(match.t ? { gameStartTimestamp: match.t } : {}),
      gameDuration: match.d || 0,
      participants,
      teams: [{ teamId: 100, win: match.w === 1, bans: bans.slice(0, half) }, { teamId: 200, win: match.w === 0, bans: bans.slice(half) }],
    },
  };
}