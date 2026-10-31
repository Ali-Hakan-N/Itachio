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

// Items bought before this time are the starting items (players leave the base by then)
const START_MS = 60_000;

/**
 * Starting items of every player from a match-v5 timeline: Map participantId -> sorted
 * item ids. Purchases in the first minute, minus those undone. Trinkets are left in;
 * builds.js keeps only items from the shop.
 */
function startingItems(timeline) {
  const out = new Map();
  for (const frame of timeline?.info?.frames || []) {
    for (const e of frame.events || []) {
      if (e.timestamp >= START_MS) continue;
      const list = out.get(e.participantId) || [];
      if (e.type === 'ITEM_PURCHASED') list.push(e.itemId);
      else if (e.type === 'ITEM_UNDO' && e.beforeId) {
        const i = list.lastIndexOf(e.beforeId);
        if (i >= 0) list.splice(i, 1);
      } else if (e.type === 'ITEM_SOLD') {
        const i = list.lastIndexOf(e.itemId);
        if (i >= 0) list.splice(i, 1);
      } else continue;
      out.set(e.participantId, list);
    }
  }
  for (const [id, list] of out) out.set(id, list.sort((a, b) => a - b));
  return out;
}

// Potions, elixirs, wards and trinkets: bought again and again, no part of a build
const NOT_BUILD = new Set([2003, 2010, 2031, 2033, 2055, 2138, 2139, 2140, 2150, 2151, 2152, 3330, 3340, 3363, 3364]);
const MAX_PURCHASES = 40;

/** Items every player bought after the first minute, in order (components too): Map participantId -> item ids */
function purchaseOrder(timeline) {
  const out = new Map();
  for (const frame of timeline?.info?.frames || []) {
    for (const e of frame.events || []) {
      if (e.timestamp < START_MS) continue;
      const list = out.get(e.participantId) || [];
      if (e.type === 'ITEM_PURCHASED' && e.itemId >= 1000 && !NOT_BUILD.has(e.itemId)) {
        if (list.length < MAX_PURCHASES) list.push(e.itemId);
      } else if (e.type === 'ITEM_UNDO' && e.beforeId) {
        const i = list.lastIndexOf(e.beforeId);
        if (i >= 0) list.splice(i, 1);
      } else continue;
      out.set(e.participantId, list);
    }
  }
  return out;
}

/**
 * What a player did to the other team (ITEM_FACTS in model/builds.js names the entries):
 * magic and physical damage to champions, healing done, seconds of crowd control on others.
 * Champions' profiles (who heals, who locks you down) come from these.
 */
function factsOf(p) {
  if (!Number.isFinite(p.magicDamageDealtToChampions)) return null;
  return [num(p.magicDamageDealtToChampions), num(p.physicalDamageDealtToChampions), num(p.totalHeal), num(p.timeCCingOthers)];
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

/**
 * Returns null for matches that should not count (other queue, remake, missing players).
 * timeline (optional, a separate request): adds every player's starting items.
 */
function parseMatch(match, timeline = null) {
  const info = match?.info;
  const id = match?.metadata?.matchId;
  if (!info || !id) return null;
  if (!QUEUES.has(info.queueId)) return null;
  if ((info.gameDuration ?? 0) < MIN_DURATION_S) return null;
  const parts = info.participants || [];
  if (parts.length !== 10 || parts.some((p) => p.gameEndedInEarlySurrender)) return null;
  const patch = patchOf(info.gameVersion);
  if (!patch) return null;
  const start = timeline ? startingItems(timeline) : null;

  return {
    id,
    platform: id.split('_')[0],
    patch,
    queue: info.queueId,
    start: info.gameStartTimestamp ?? info.gameCreation ?? 0,
    dur: info.gameDuration,
    first: firstsOf(info.teams),
    b: (info.teams || []).flatMap((t) => (t.bans || []).map((b) => b.championId)).filter((c) => c > 0),
    p: parts.map((p) => {
      const l = laneOf(p);
      const g = gearOf(p);
      const s = start?.get(p.participantId);
      const x = factsOf(p);
      return { c: p.championId, r: ROLE[p.teamPosition] || '', t: p.teamId, w: !!p.win, ...(p.participantId && { i: p.participantId }), ...(x && { x }), ...(l && { l }), ...(g && { g }), ...(s?.length && { s }) };
    }),
  };
}

module.exports = { parseMatch, patchOf, startingItems, purchaseOrder };
