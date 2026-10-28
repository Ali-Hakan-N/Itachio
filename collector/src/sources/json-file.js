// Reads a JSON file in the standard format (see the top of src/normalize.js).
// For importing hand-made data and for trying out the collector.

const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = {
  name: 'json-file',
  async collect({ env, log }) {
    const file = env.COLLECTOR_FILE;
    if (!file) throw new Error('COLLECTOR_FILE is not set');
    const full = path.resolve(file);
    log(`reading ${full}`);
    return JSON.parse(await fs.readFile(full, 'utf8'));
  },
};
