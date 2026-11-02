const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettings } = require('../src/main/settings');

test('settings persist the three options and ignore anything else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itachio-settings-'));
  const s = createSettings(path.join(dir, 'nested', 'settings.json'));
  assert.deepEqual(s.load(), {});
  assert.deepEqual(s.save({ autoRunes: true, evil: 1 }), { autoRunes: true });
  assert.deepEqual(s.save({ openAtLogin: 1, autoRunes: false }), { autoRunes: false, openAtLogin: true });
  assert.deepEqual(createSettings(path.join(dir, 'nested', 'settings.json')).load(), { autoRunes: false, openAtLogin: true });
});
