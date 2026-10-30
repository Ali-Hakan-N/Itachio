const test = require('node:test');
const assert = require('node:assert/strict');
const { writeMetaSourceSnapshot } = require('../src/writer');

test('MetaSrc snapshot stores only prediction features with patch and collection time', async () => {
  let inserted;
  let prunedBefore;
  const client = {
    from(table) {
      assert.equal(table, 'meta_source_snapshots');
      return {
        insert: async (row) => {
          inserted = row;
          return { data: null, error: null };
        },
        delete: () => ({
          lt: async (_column, cutoff) => {
            prunedBefore = cutoff;
            return { data: [], error: null };
          },
        }),
      };
    },
  };
  const rows = {
    meta: [{ champion_id: 1, role: 'top', score: 60, source: 'metasrc', collected_at: 'ignored' }],
    synergy: [{ champion_id: 1, role: 'top', ally_id: 2, strength: 0.3 }],
    matchup: [{ champion_id: 1, role: 'top', opponent_id: 3, opponent_role: 'top', strength: 0.2 }],
  };

  assert.equal(await writeMetaSourceSnapshot(client, { patch: '16.22', collectedAt: '2026-10-30T12:00:00Z', rows }), true);
  assert.deepEqual(inserted, {
    source: 'metasrc',
    patch: '16.22',
    collected_at: '2026-10-30T12:00:00Z',
    data: {
      meta: [{ champion_id: 1, role: 'top', score: 60 }],
      synergy: [{ champion_id: 1, role: 'top', ally_id: 2, strength: 0.3 }],
      matchup: [{ champion_id: 1, role: 'top', opponent_id: 3, opponent_role: 'top', strength: 0.2 }],
    },
  });
  assert.equal(prunedBefore, '2026-07-02T12:00:00.000Z');
});

test('MetaSrc snapshot is skipped without a patch or meta data', async () => {
  const client = { from: () => { throw new Error('should not write'); } };
  assert.equal(await writeMetaSourceSnapshot(client, { patch: null, rows: { meta: [] } }), false);
});