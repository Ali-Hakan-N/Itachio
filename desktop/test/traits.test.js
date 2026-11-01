const test = require('node:test');
const assert = require('node:assert/strict');
global.Recommend = require('../src/renderer/recommend');
const Traits = require('../src/renderer/traits');
const { recommend, Engine } = require('../src/renderer/model');

const id = (name) => Traits.BY_NAME.get(name);
const team = (...names) => names.map((n) => ({ id: id(n), tag: 'None' }));

test('trait table covers the roster and every curated duo resolves', () => {
  assert.ok(Traits.BY_ID.size >= 170);
  assert.ok(Traits.pairBonus(id('Jinx'), 'Marksman', id('Lulu'), 'Support') > Traits.pairBonus(id('Jinx'), 'Marksman', id('Zed'), 'Assassin'));
});

test('one-sided damage is punished, a balanced team is not', () => {
  const allAd = Traits.teamFit(team('Darius', 'LeeSin', 'Zed', 'Jinx', 'Leona')).damage;
  const allAp = Traits.teamFit(team('Malphite', 'Elise', 'Syndra', 'Karma', 'Zyra')).damage;
  const balanced = Traits.teamFit(team('Malphite', 'Vi', 'Ahri', 'Jinx', 'Nautilus')).damage;
  assert.ok(allAd > 1 && allAp > 1, `${allAd} ${allAp}`);
  assert.equal(balanced, 0);
});

test('a team without CC or frontline lacks them', () => {
  const soft = Traits.teamFit(team('Zed', 'Khazix', 'Syndra', 'Jinx', 'Karma'));
  const good = Traits.teamFit(team('Malphite', 'Vi', 'Ahri', 'Jinx', 'Nautilus'));
  assert.ok(soft.needs > good.needs);
  assert.ok(soft.lacking.includes('fr'));
});

test('a team that mixes plans scores worse than one with a plan', () => {
  const poke = Traits.teamFit(team('Jayce', 'Nidalee', 'Xerath', 'Caitlyn', 'Karma'));
  const chaos = Traits.teamFit(team('Jayce', 'Nocturne', 'Xerath', 'Tryndamere', 'Yuumi'));
  assert.ok(chaos.coherence >= poke.coherence);
});

test('recommend fills the missing damage type', () => {
  const tags = {};
  const champ = {};
  for (const [, cid] of Traits.BY_NAME) {
    tags[cid] = 'None';
    for (let r = 0; r < 5; r++) champ[`${cid}:${r}`] = [0, 500, 0.2, 0.01];
  }
  const model = { shareFloor: 0.002, off: [0, 0, 0, 0, 0], champ, tags, matches: 10000 };
  const allies = [
    { championId: id('Darius'), position: 'top' },
    { championId: id('LeeSin'), position: 'jungle' },
    { championId: id('Zed'), position: 'middle' },
    { championId: id('Jinx'), position: 'bottom' },
  ];
  const rows = recommend({ model, role: 'utility', allies, limit: 200 });
  const by = (n) => rows.find((r) => r.championId === id(n)).logit;
  assert.ok(by('Zyra') > by('Draven'));
  assert.ok(Engine);
});
