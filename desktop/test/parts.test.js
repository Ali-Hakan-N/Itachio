const test = require('node:test');
const assert = require('node:assert/strict');
global.Recommend = require('../src/renderer/recommend');
const Traits = require('../src/renderer/traits');
const { Engine } = require('../src/renderer/model');

const id = (name) => Traits.BY_NAME.get(name);

test('the parts of a pick add up to its logit', () => {
  const champ = { [`${id('Zyra')}:4`]: [0.05, 500, 0.2, 0.01], [`${id('Jinx')}:3`]: [0, 500, 0.2, 0.01] };
  const model = { shareFloor: 0.002, off: [0, 0, 0, 0, 0], champ, tags: {}, matches: 10000 };
  const row = Engine.evaluate({ model, championId: id('Zyra'), role: 'utility', allies: [{ championId: id('Jinx'), position: 'bottom' }], lookAhead: true });
  const sum = Object.values(row.parts).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - row.logit) < 1e-9, `${sum} ${row.logit}`);
});
