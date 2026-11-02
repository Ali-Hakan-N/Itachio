const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/renderer/traits');

const names = new Map([...T.BY_NAME].map(([n, id]) => [id, n]));

test('trait scores follow one rubric', () => {
  const bad = [];
  for (const [id, p] of T.BY_ID) {
    const n = names.get(id);
    for (const k of T.KEYS) if (!(p[k] >= 0) || p[k] > (k === 'mg' ? 1 : 3)) bad.push(`${n}: ${k} out of range`);
    if (p.en >= 3 && p.cc < 2) bad.push(`${n}: hard engage without crowd control`);
    if (p.fr >= 3 && p.cc < 1) bad.push(`${n}: tank without crowd control`);
    if (p.pk >= 3 && p.fr >= 2) bad.push(`${n}: poke champion that is also a frontline`);
    if (p.sp >= 3 && p.en >= 3) bad.push(`${n}: split pusher that is also a hard engage`);
    if (p.ac >= 3 && p.wc < 2) bad.push(`${n}: area control without waveclear`);
  }
  assert.deepEqual(bad, []);
});

test('the comp profile follows the picks', () => {
  const pick = (...list) => list.map((n) => ({ id: T.BY_NAME.get(n), tag: 'None' }));
  assert.equal(T.compProfile([]).label, 'Open draft');
  const poke = T.compProfile(pick('Jayce', 'Xerath', 'Caitlyn'));
  assert.equal(poke.plan, 'pk');
  assert.equal(poke.needs.find((x) => x.key === 'pk').state === 'missing', false);
  const dive = T.compProfile(pick('Malphite', 'Vi', 'Amumu', 'Leona'));
  assert.equal(dive.plan, 'en');
  assert.equal(dive.damage.state, 'balanced');
  assert.equal(T.compProfile(pick('Darius', 'LeeSin', 'Zed', 'Jinx', 'Leona')).damage.state, 'ad-heavy');
});
