// Options kept on this computer (settings.json in the user data folder).
const fs = require('node:fs');
const path = require('node:path');

const KEYS = ['autoRunes', 'autoItems', 'openAtLogin'];

function createSettings(file) {
  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  // Writes only the known keys, as booleans; returns what is saved
  const save = (changes) => {
    const saved = { ...load() };
    for (const key of KEYS) if (key in changes) saved[key] = !!changes[key];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(saved));
    return saved;
  };
  return { load, save };
}

module.exports = { createSettings, KEYS };
