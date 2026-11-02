const test = require('node:test');
const assert = require('node:assert/strict');
const { makeGate } = require('../src/model/idle');

test('the gate waits while the computer is busy and lets requests through when it is free', async () => {
  const states = [{ busy: true, load: 80, game: false }, { busy: true, load: 70, game: false }, { busy: false, load: 5, game: false }];
  let probes = 0;
  const logs = [];
  const gate = makeGate({ log: (m) => logs.push(m), probe: async () => states[Math.min(probes++, 2)], sleep: async () => {} });
  await Promise.all([gate(), gate()]);
  assert.equal(probes, 3, 'one check at a time, shared by every caller');
  assert.equal(logs.length, 2);
  await gate();
  assert.equal(probes, 3, 'a free answer is kept for a while');
});

test('the gate lets go when the run is stopping', async () => {
  const gate = makeGate({ probe: async () => ({ busy: true, load: 99, game: true }), sleep: async () => {}, isStopped: () => true });
  await gate();
});
