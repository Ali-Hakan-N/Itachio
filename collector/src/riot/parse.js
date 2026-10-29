// Converts a Riot match-v5 response into the riot_ingest() format. Pure function.

const QUEUES = new Set([420, 440]); // Solo/Duo, Flex
const ROLE = { TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'middle', BOTTOM: 'bottom', UTILITY: 'utility' };
const MIN_DURATION_S = 300; // anything shorter is a remake
const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);

const OBJECTIVES = ['champion', 'tower', 'dragon', 'riftHerald', 'horde']; // first blood, tower, ...

/**
 * Early game of one player, from match-v5 "challenges" (no extra request). LANE_FIELDS
 * in model/early.js names the entries: lane minions and jungle monsters by 10 minutes,
 * turret plates, gold+xp lead over the lane opponent early in and at the end of the
 * laning phase (1/0), takedowns in the first minutes, solo kills. Plates, takedowns and
 * solo kills count over the whole game, so the early game model leaves them out.
 */
function laneOf(p) {
  const c = p.challenges;
  if (!c) return null;
  return [
    num(c.laneMinionsFirst10Minutes),
    num(c.jungleCsBefore10Minutes),
    num(c.turretPlatesTaken),
    num(c.earlyLaningPhaseGoldExpAdvantage),
    num(c.laningPhaseGoldExpAdvantage),
    num(c.takedownsFirstXMinutes),
    num(c.soloKills),
  ];
}

/**
 * Runes, items and summoner spells of one player (GEAR in model/builds.js names the
 * entries): primary tree and its 4 runes, secondary tree and its 2 runes, the 3 shards
 * (offense, flex, defense), the 6 item slots at the end of the game (0 = empty; no
 * trinket) and the 2 summoner spells.
 */
function gearOf(p) {
  const [main, sub] = p.perks?.styles || [];
  const shards = p.perks?.statPerks || {};
  if (!main || !sub) return null;
  const runes = (st, n) => Array.from({ length: n }, (_, i) => st.selections?.[i]?.perk || 0);
  return [
    main.style || 0, ...runes(main, 4),
    sub.style || 0, ...runes(sub, 2),
    shards.offense || 0, shards.flex || 0, shards.defense || 0,
    p.item0 || 0, p.item1 || 0, p.item2 || 0, p.item3 || 0, p.item4 || 0, p.item5 || 0,
    p.summoner1Id || 0, p.summoner2Id || 0,
  ];
}

/** Team that took each first objective (OBJECTIVES order): 100, 200 or 0 */
function firstsOf(teams) {
  return OBJECTIVES.map((o) => (teams || []).find((t) => t.objectives?.[o]?.first)?.teamId || 0);
}

/** "16.21.712.5555" or "16.21.1" -> "16.21" */
function patchOf(version) {
  const m = /^(\d+)\.(\d+)/.exec(version || '');
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Returns null for matches that should not count (other queue, remake, missing players) */
function parseMatch(match) {
  const info = match?.info;
  const id = match?.metadata?.matchId;
  if (!info || !id) return null;
  if (!QUEUES.has(info.queueId)) return null;
  if ((info.gameDuration ?? 0) < MIN_DURATION_S) return null;
  const parts = info.participants || [];
  if (parts.length !== 10 || parts.some((p) => p.gameEndedInEarlySurrender)) return null;
  const patch = patchOf(info.gameVersion);
  if (!patch) return null;

  return {
    id,
    platform: id.split('_')[0],
    patch,
    queue: info.queueId,
    start: info.gameStartTimestamp ?? info.gameCreation ?? 0,
    first: firstsOf(info.teams),
    b: (info.teams || []).flatMap((t) => (t.bans || []).map((b) => b.championId)).filter((c) => c > 0),
    p: parts.map((p) => {
      const l = laneOf(p);
      const g = gearOf(p);
      return { c: p.championId, r: ROLE[p.teamPosition] || '', t: p.teamId, w: !!p.win, ...(l && { l }), ...(g && { g }) };
    }),
  };
}

module.exports = { parseMatch, patchOf };
