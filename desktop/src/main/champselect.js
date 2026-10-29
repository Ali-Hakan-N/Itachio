// Turns the LCU champ select session into the app's simple draft model.
// Pure functions: testable, no side effects.

const POSITIONS = ['top', 'jungle', 'middle', 'bottom', 'utility'];

function flatActions(session) {
  return (session.actions || []).flat().filter(Boolean);
}

/**
 * @returns {{
 *   gameId: number|null, ourSide: 'blue'|'red', phase: string, endsAt: number|null,
 *   localCellId: number, isOurTurn: boolean, myPickActionId: number|null, myBanActionId: number|null,
 *   banHoverId: number, turn: null|{side:'ally'|'enemy', kind:'ban'|'pick', cellIds:number[]},
 *   ally: Array<{cellId:number, championId:number, hoverId:number, locked:boolean, position:string, puuid:string, isLocal:boolean}>,
 *   enemy: Array<{cellId:number, championId:number, locked:boolean, position:string}>,
 *   allyBans: number[], enemyBans: number[],
 *   completed: Array<{side:'ally'|'enemy', kind:'ban'|'pick', seq:number, championId:number, actorCellId:number}>
 * }}
 */
function normalizeSession(session, now = Date.now()) {
  const actions = flatActions(session);
  const localCellId = session.localPlayerCellId ?? -1;
  const myTeam = session.myTeam || [];
  const theirTeam = session.theirTeam || [];

  const allyTeamNo = myTeam[0]?.team ?? (localCellId >= 0 && localCellId < 5 ? 1 : 2);
  const ourSide = allyTeamNo === 2 ? 'red' : 'blue';

  const pickDone = new Map(); // cellId -> championId
  for (const a of actions) {
    if (a.type === 'pick' && a.completed && a.championId > 0) pickDone.set(a.actorCellId, a.championId);
  }
  const hasPickActions = actions.some((a) => a.type === 'pick');

  const ally = myTeam.map((p) => {
    const locked = pickDone.has(p.cellId) || (!hasPickActions && p.championId > 0);
    const championId = locked ? pickDone.get(p.cellId) || p.championId || 0 : 0;
    return {
      cellId: p.cellId,
      championId,
      hoverId: locked ? 0 : p.championId || p.championPickIntent || 0,
      locked,
      position: POSITIONS.includes(p.assignedPosition) ? p.assignedPosition : '',
      puuid: p.puuid || '',
      isLocal: p.cellId === localCellId,
    };
  });

  const enemy = theirTeam.map((p) => {
    const done = pickDone.get(p.cellId);
    const championId = done || p.championId || 0;
    return {
      cellId: p.cellId,
      championId,
      locked: championId > 0,
      position: POSITIONS.includes(p.assignedPosition) ? p.assignedPosition : '',
    };
  });

  // Completed bans/picks in order, numbered per side
  const counters = { 'ally:ban': 0, 'ally:pick': 0, 'enemy:ban': 0, 'enemy:pick': 0 };
  const completed = [];
  for (const a of actions) {
    if (!a.completed || (a.type !== 'ban' && a.type !== 'pick')) continue;
    if (!(a.championId > 0)) continue; // skipped ban
    const side = a.isAllyAction ? 'ally' : 'enemy';
    const key = `${side}:${a.type}`;
    counters[key] += 1;
    completed.push({ side, kind: a.type, seq: counters[key], championId: a.championId, actorCellId: a.actorCellId });
  }

  let allyBans = completed.filter((c) => c.side === 'ally' && c.kind === 'ban').map((c) => c.championId);
  let enemyBans = completed.filter((c) => c.side === 'enemy' && c.kind === 'ban').map((c) => c.championId);
  // In some modes bans only show up in session.bans
  if (!allyBans.length) allyBans = (session.bans?.myTeamBans || []).filter((id) => id > 0);
  if (!enemyBans.length) enemyBans = (session.bans?.theirTeamBans || []).filter((id) => id > 0);

  // The local player's next pick that is not locked yet: the app can set a hover on it
  const myPick = actions.find((a) => a.actorCellId === localCellId && a.type === 'pick' && !a.completed);
  // The same for our ban, with the champion currently hovered for it
  const myBan = actions.find((a) => a.actorCellId === localCellId && a.type === 'ban' && !a.completed);

  const inProgress = actions.filter((a) => a.isInProgress && !a.completed);
  const turn = inProgress.length
    ? {
        side: inProgress[0].isAllyAction ? 'ally' : 'enemy',
        kind: inProgress[0].type === 'ban' ? 'ban' : 'pick',
        cellIds: inProgress.map((a) => a.actorCellId),
      }
    : null;

  const left = session.timer?.adjustedTimeLeftInPhase;
  return {
    gameId: session.gameId > 0 ? session.gameId : null,
    ourSide,
    phase: session.timer?.phase || '',
    endsAt: typeof left === 'number' && left > 0 ? now + left : null,
    localCellId,
    isOurTurn: !!turn && turn.cellIds.includes(localCellId),
    myPickActionId: myPick ? myPick.id : null,
    myBanActionId: myBan ? myBan.id : null,
    banHoverId: myBan && myBan.championId > 0 ? myBan.championId : 0,
    turn,
    ally,
    enemy,
    allyBans,
    enemyBans,
    completed,
  };
}

/** Champions that cannot be recommended: bans + locked picks */
function unavailableIds(draft) {
  const ids = new Set([...draft.allyBans, ...draft.enemyBans]);
  for (const p of [...draft.ally, ...draft.enemy]) if (p.locked && p.championId) ids.add(p.championId);
  return ids;
}

module.exports = { normalizeSession, unavailableIds, POSITIONS };
