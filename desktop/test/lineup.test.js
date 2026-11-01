const test = require('node:test');
const assert = require('node:assert/strict');
const { lineupRoles } = require('../src/renderer/model');
const { normalizeLobby } = require('../src/main/champselect');

const stat = (role, delta, games) => ({ byKey: { [`1:${role}`]: { delta, games, wins: games / 2, early: 0, late: 0 } }, unplayed: -0.02 });
const ids = ['a', 'b', 'c', 'd', 'e'];
const roles = ['top', 'jungle', 'middle', 'bottom', 'utility'];
const members = ids.map((id) => ({ id }));

test('each player is put on the role their statistics favour', () => {
  const playerStats = Object.fromEntries(ids.map((id, i) => [id, { season: stat(roles[(i + 2) % 5], 0.05, 40) }]));
  const res = lineupRoles({ model: null, members, playerStats });
  const byId = Object.fromEntries(res.options[0].picks.map((p) => [p.id, p.role]));
  ids.forEach((id, i) => assert.equal(byId[id], roles[(i + 2) % 5]));
  assert.ok(res.margin > 0);
});

test('games with exactly this line-up count', () => {
  const key = [...ids].sort().join(',');
  const playerStats = Object.fromEntries(ids.map((id, i) => [id, {
    season: stat(roles[i], 0.01, 20),
    team: { [key]: stat(roles[(i + 1) % 5], 0.1, 20) },
  }]));
  const res = lineupRoles({ model: null, members, playerStats });
  assert.equal(res.options[0].picks.find((p) => p.id === 'a').role, roles[1]);
});

test('needs five members; the lobby is read from the client', () => {
  assert.equal(lineupRoles({ model: null, members: members.slice(0, 4), playerStats: {} }), null);
  const lobby = normalizeLobby({ localMember: { puuid: 'x' }, gameConfig: { queueId: 440 }, members: [{ puuid: 'x', firstPositionPreference: 'MIDDLE', secondPositionPreference: 'FILL' }] });
  assert.deepEqual(lobby.members[0], { puuid: 'x', isLocal: true, preferences: ['middle'] });
  assert.equal(normalizeLobby(null), null);
});
