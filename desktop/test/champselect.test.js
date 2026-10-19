const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSession, unavailableIds } = require('../src/main/champselect');
const { parseEndOfGame } = require('../src/main/endofgame');
const { buildSession, EOG_BLOCK, SCRIPT } = require('./mock-lcu');

test('başlangıçta: mavi taraf, sıra bizde ban', () => {
  const d = normalizeSession(buildSession(0), 1000);
  assert.equal(d.ourSide, 'blue');
  assert.equal(d.gameId, 7000000001);
  assert.equal(d.phase, 'BAN_PICK');
  assert.equal(d.endsAt, 1000 + 27000);
  assert.deepEqual(d.turn, { side: 'ally', kind: 'ban', cellIds: [0] });
  assert.equal(d.isOurTurn, false);
  assert.equal(d.completed.length, 0);
  // Yerel oyuncunun ön seçimi hover olarak görünür
  const local = d.ally.find((p) => p.isLocal);
  assert.equal(local.position, 'middle');
  assert.equal(local.hoverId, 103);
  assert.equal(local.locked, false);
});

test('rakibin sıradaki pick\'i kilitlenmeden görünmez', () => {
  const d = normalizeSession(buildSession(7)); // kırmızı ilk pick sırası
  assert.equal(d.turn.side, 'enemy');
  assert.equal(d.enemy.find((p) => p.cellId === 5).championId, 0);
  const d2 = normalizeSession(buildSession(8));
  assert.equal(d2.enemy.find((p) => p.cellId === 5).championId, 64);
  assert.equal(d2.enemy.find((p) => p.cellId === 5).locked, true);
});

test('sıra yerel oyuncuda iken isOurTurn', () => {
  const d = normalizeSession(buildSession(10)); // hücre 2 pick
  assert.equal(d.isOurTurn, true);
  assert.equal(d.ally.find((p) => p.isLocal).hoverId, 103);
});

test('draft sonu: tüm ban/pick\'ler sıralı ve doğru tarafta', () => {
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

test('kırmızı tarafı doğru algılar', () => {
  const s = buildSession(3);
  s.myTeam = s.myTeam.map((p) => ({ ...p, team: 2 }));
  assert.equal(normalizeSession(s).ourSide, 'red');
});

test('boş geçilen ban kaydedilmez', () => {
  const s = buildSession(2);
  s.actions[0][0].championId = 0;
  const d = normalizeSession(s);
  assert.equal(d.completed.length, 1);
  assert.equal(d.completed[0].side, 'enemy');
});

test('maç sonu verisi', () => {
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
