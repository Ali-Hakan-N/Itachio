const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSession, unavailableIds } = require('../src/main/champselect');
const { parseEndOfGame } = require('../src/main/endofgame');
const { buildSession, EOG_BLOCK, SCRIPT } = require('./mock-lcu');

test('at start: blue side, our ban turn', () => {
  const d = normalizeSession(buildSession(0), 1000);
  assert.equal(d.ourSide, 'blue');
  assert.equal(d.gameId, 7000000001);
  assert.equal(d.phase, 'BAN_PICK');
  assert.equal(d.endsAt, 1000 + 27000);
  assert.deepEqual(d.turn, { side: 'ally', kind: 'ban', cellIds: [0] });
  assert.equal(d.isOurTurn, false);
  assert.equal(d.completed.length, 0);
  // The local player's pre-pick shows up as a hover
  const local = d.ally.find((p) => p.isLocal);
  assert.equal(local.position, 'middle');
  assert.equal(local.hoverId, 103);
  assert.equal(local.locked, false);
});

test('the enemy pick in progress is hidden until locked', () => {
  const d = normalizeSession(buildSession(7)); // red side's first pick turn
  assert.equal(d.turn.side, 'enemy');
  assert.equal(d.enemy.find((p) => p.cellId === 5).championId, 0);
  const d2 = normalizeSession(buildSession(8));
  assert.equal(d2.enemy.find((p) => p.cellId === 5).championId, 64);
  assert.equal(d2.enemy.find((p) => p.cellId === 5).locked, true);
});

test('isOurTurn while the local player is acting', () => {
  const d = normalizeSession(buildSession(10)); // cell 2 picking
  assert.equal(d.isOurTurn, true);
  assert.equal(d.ally.find((p) => p.isLocal).hoverId, 103);
});

test('end of draft: all bans/picks in order and on the right side', () => {
  const d = normalizeSession(buildSession(SCRIPT.length));
  assert.equal(d.phase, 'FINALIZATION');
  assert.equal(d.turn, null);
  assert.deepEqual(d.allyBans, [238, 875, 777, 104, 122]);
  assert.deepEqual(d.enemyBans, [157, 99, 234, 81, 141]);
  assert.deepEqual(d.ally.map((p) => p.championId), [86, 254, 103, 145, 412]);
  assert.deepEqual(d.enemy.map((p) => p.championId), [64, 61, 222, 111, 58]);
  assert.equal(d.completed.length, 20);
  const allyPicks = d.completed.filter((c) => c.side === 'ally' && c.kind === 'pick');
  assert.deepEqual(allyPicks.map((c) => c.seq), [1, 2, 3, 4, 5]);
  assert.equal(unavailableIds(d).size, 20);
});

test('detects the red side', () => {
  const s = buildSession(3);
  s.myTeam = s.myTeam.map((p) => ({ ...p, team: 2 }));
  assert.equal(normalizeSession(s).ourSide, 'red');
});

test('a skipped ban is not recorded', () => {
  const s = buildSession(2);
  s.actions[0][0].championId = 0;
  const d = normalizeSession(s);
  assert.equal(d.completed.length, 1);
  assert.equal(d.completed[0].side, 'enemy');
});

test('end-of-game data', () => {
  const r = parseEndOfGame(EOG_BLOCK);
  assert.equal(r.win, true);
  assert.equal(r.kills, 9);
  assert.equal(r.cs, 226);
  assert.equal(r.championId, 103);
  assert.equal(r.durationS, 1834);
  assert.equal(parseEndOfGame({}), null);
  const lost = parseEndOfGame({ gameId: 5, localPlayer: { stats: { WIN: 0 } } });
  assert.equal(lost.win, false);
});

test('finds the local player pick action until it is locked', () => {
  assert.equal(normalizeSession(buildSession(0)).myPickActionId, 11);
  assert.equal(normalizeSession(buildSession(SCRIPT.length)).myPickActionId, null);
});

test('our ban: action id while it is open, with the hovered champion', () => {
  // Local cell 2 bans fifth (action id 5, champion 777)
  assert.equal(normalizeSession(buildSession(0)).myBanActionId, 5);
  const during = normalizeSession(buildSession(4));
  assert.equal(during.myBanActionId, 5);
  assert.equal(during.banHoverId, 777);
  assert.equal(normalizeSession(buildSession(5)).myBanActionId, null);
});

test('pick numbers stay the same when the second of two simultaneous picks locks first', () => {
  const act = (id, cell, champ, completed) => ({ id, actorCellId: cell, championId: champ, completed, isAllyAction: cell < 5, isInProgress: !completed, type: 'pick' });
  const session = (first, second) => ({
    gameId: 1, localPlayerCellId: 0,
    myTeam: [0, 1].map((c) => ({ cellId: c, team: 1 })), theirTeam: [],
    actions: [[act(1, 0, 143, first), act(2, 1, 53, second)]],
  });
  const early = normalizeSession(session(false, true)).completed; // cell 1 locked first
  const both = normalizeSession(session(true, true)).completed;
  assert.deepEqual(early.map((a) => [a.seq, a.championId]), [[2, 53]]);
  assert.deepEqual(both.map((a) => [a.seq, a.championId]), [[1, 143], [2, 53]]);
});

test('exposes future simultaneous ally picks before their turn becomes active', () => {
  const act = (id, cell) => ({
    id, actorCellId: cell, type: 'pick', isAllyAction: true, isInProgress: false,
    championId: 0, completed: false,
  });
  const session = {
    gameId: 2, localPlayerCellId: 0,
    myTeam: [0, 1, 2].map((cellId) => ({ cellId, team: 1 })), theirTeam: [],
    actions: [[act(1, 0), act(2, 1)], [act(3, 2)]],
  };

  const draft = normalizeSession(session);
  assert.equal(draft.turn, null);
  assert.deepEqual(draft.allyPickGroups, [[0, 1]]);
});
