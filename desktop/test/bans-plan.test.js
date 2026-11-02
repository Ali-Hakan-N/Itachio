const test = require('node:test');
const assert = require('node:assert/strict');
global.Recommend = require('../src/renderer/recommend');
const Traits = require('../src/renderer/traits');
const { recommendBans, recommend } = require('../src/renderer/model');
const { teamHistoryOf } = require('../src/main/core');

const id = (n) => Traits.BY_NAME.get(n);

test('team history counts the enemy champions the five met and our wins', () => {
  const h = teamHistoryOf([
    { side: 'blue', win: false, blue: [1, 2, 3, 4, 5], red: [10, 11, 12, 13, 14] },
    { side: 'red', win: true, blue: [10, 2, 3, 4, 5], red: [1, 11, 12, 13, 14] },
  ]);
  assert.deepEqual(h.byChampion[10], [2, 1]);
  assert.equal(h.byChampion[1], undefined, 'our own champions are not counted');
  assert.equal(h.games, 2);
});

function bansModel() {
  const champ = {};
  for (const n of ['Zed', 'Jinx', 'Lulu']) for (let r = 0; r < 5; r++) champ[`${id(n)}:${r}`] = [0, 600, r === 2 ? 0.8 : 0.05, 0.01];
  return { shareFloor: 0.002, off: [0, 0, 0, 0, 0], champ, tags: {}, matches: 10000 };
}

test('bans lean on what the five lost to, by how many games it rests on', () => {
  const model = bansModel();
  const base = recommendBans({ model, limit: 50 }).find((b) => b.championId === id('Zed'));
  const lost = recommendBans({ model, limit: 50, history: { [id('Zed')]: [6, 0] } }).find((b) => b.championId === id('Zed'));
  const one = recommendBans({ model, limit: 50, history: { [id('Zed')]: [1, 0] } }).find((b) => b.championId === id('Zed'));
  assert.ok(lost.value > (one?.value ?? 0) && lost.value > (base?.value ?? 0));
  assert.deepEqual(lost.history, { games: 6, wins: 0 });
});

test('champions that fit the comp being built score above unrelated ones', () => {
  const champ = {};
  for (const n of ['Jayce', 'Xerath', 'Caitlyn', 'Ziggs', 'Garen', 'Yasuo', 'Amumu']) for (let r = 0; r < 5; r++) champ[`${id(n)}:${r}`] = [0, 600, 0.2, 0.01];
  const model = { shareFloor: 0.002, off: [0, 0, 0, 0, 0], champ, tags: {}, matches: 10000 };
  const allies = [{ championId: id('Jayce'), position: 'top' }, { championId: id('Xerath'), position: 'middle' }, { championId: id('Caitlyn'), position: 'bottom' }];
  const rows = recommend({ model, role: 'jungle', allies, limit: 20 });
  const by = (n) => rows.find((r) => r.championId === id(n)).logit;
  assert.ok(by('Ziggs') > by('Yasuo'), 'poke champion over an unrelated skirmisher');
  assert.ok(Traits.planSupport([{ id: id('Jayce') }, { id: id('Xerath') }, { id: id('Caitlyn') }], { id: id('Ziggs') }) > Traits.planSupport([{ id: id('Jayce') }, { id: id('Xerath') }, { id: id('Caitlyn') }], { id: id('Garen') }));
});
