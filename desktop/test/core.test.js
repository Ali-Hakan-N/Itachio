// Uçtan uca: sahte LCU -> gerçek LcuConnector -> AppCore -> sahte veritabanı
const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockLcu, SCRIPT } = require('./mock-lcu');
const { LcuConnector } = require('../src/main/lcu');
const { AppCore } = require('../src/main/core');

function fakeData() {
  const calls = [];
  const db = { drafts: new Map(), actions: new Map(), results: [] };
  const me = { id: 'p-local', team_id: 't1', nickname: 'Ali', puuid: null };
  const championIds = [...new Set(SCRIPT.map((s) => s[2]))];
  return {
    calls,
    db,
    loadMe: async () => ({ ...me }),
    loadChampions: async () => ({ patch: '16.20.1', champions: championIds.map((id) => ({ id, name: `C${id}` })) }),
    loadMetaScores: async () => [],
    loadTeam: async () => ({
      team: { id: 't1', name: 'Test' },
      members: [
        { id: 'p-local', puuid: 'mock-puuid-local' },
        { id: 'p-jungle', puuid: 'mock-puuid-1' },
      ],
      pools: [],
    }),
    linkRiotAccount: async (m, { puuid, riotId }) => {
      calls.push(['link', puuid, riotId]);
      me.puuid = puuid;
      return { ...m, puuid, riot_id: riotId };
    },
    ensureDraft: async (args) => {
      calls.push(['ensureDraft', args.gameId]);
      if (!db.drafts.has(args.gameId)) db.drafts.set(args.gameId, { id: `d-${args.gameId}`, status: 'live', ...args });
      return db.drafts.get(args.gameId);
    },
    addDraftActions: async (rows) => {
      for (const r of rows) db.actions.set(`${r.side}:${r.kind}:${r.seq}`, r);
    },
    updateDraft: async (id, fields) => {
      calls.push(['updateDraft', id, fields.status, fields.result]);
      for (const d of db.drafts.values()) if (d.id === id) Object.assign(d, fields);
    },
    findDraftByGame: async (_t, gameId) => db.drafts.get(gameId) || null,
    saveMatchResult: async (row) => db.results.push(row),
    subscribeTeam: () => {},
    unsubscribe: () => {},
  };
}

test('sahte LCU senaryosu baştan sona kaydedilir', async () => {
  const mock = await startMockLcu({ stepMs: 25, quiet: true });
  process.env.LCU_LOCKFILE = mock.lockfilePath;
  const lcu = new LcuConnector({ pollMs: 50 });
  const data = fakeData();
  const core = new AppCore({ lcu, data, log: { error: () => {} } });
  await core.loadUserData();

  const seenPhases = [];
  let maxCompleted = 0;
  core.on('update', (p) => {
    if (p.lcu) seenPhases.push(p.lcu.phase);
    if (p.draft) maxCompleted = Math.max(maxCompleted, p.draft.completed.length);
  });
  const saved = new Promise((r) => core.on('saved', r));

  lcu.start();
  await mock.finished;
  await saved;
  await core.queue;
  lcu.stop();
  await mock.close();

  // Draft canlı izlendi
  assert.equal(maxCompleted, 20);
  assert.ok(seenPhases.includes('ChampSelect') && seenPhases.includes('InProgress') && seenPhases.includes('EndOfGame'));

  // Hesap bağlandı
  assert.ok(data.calls.some((c) => c[0] === 'link' && c[1] === 'mock-puuid-local' && c[2] === 'Deneme#TR1'));

  // Aynı maç için tek draft kaydı, 20 aksiyon
  assert.equal(data.db.drafts.size, 1);
  assert.equal(data.db.actions.size, 20);
  const myPick = data.db.actions.get('ally:pick:3');
  assert.equal(myPick.champion_id, 103);
  assert.equal(myPick.role, 'middle');
  assert.equal(myPick.player_id, 'p-local');
  assert.equal(data.db.actions.get('ally:pick:2').player_id, 'p-jungle');
  assert.equal(data.db.actions.get('enemy:pick:1').player_id, null);

  // Oyun başladı -> bitti, sonuç kazanç
  const draft = [...data.db.drafts.values()][0];
  assert.equal(draft.status, 'finished');
  assert.equal(draft.result, 'win');
  assert.ok(data.calls.some((c) => c[0] === 'updateDraft' && c[2] === 'played'));

  // Maç sonucu tek kez yazıldı ve draft'a bağlandı
  assert.equal(data.db.results.length, 1);
  assert.equal(data.db.results[0].draft_id, draft.id);
  assert.equal(data.db.results[0].kills, 9);
});

test('dodge: oyun başlamadan lobiye dönülürse draft dodged olur', async () => {
  const lcu = new (require('node:events').EventEmitter)();
  lcu.get = async () => null;
  const data = fakeData();
  const core = new AppCore({ lcu, data, log: { error: () => {} } });
  await core.loadUserData();
  const { buildSession } = require('./mock-lcu');

  lcu.emit('event', { uri: '/lol-gameflow/v1/gameflow-phase', data: 'ChampSelect' });
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: buildSession(4), eventType: 'Update' });
  await core.queue;
  lcu.emit('event', { uri: '/lol-gameflow/v1/gameflow-phase', data: 'Lobby' });
  await core.queue;

  assert.equal([...data.db.drafts.values()][0].status, 'dodged');
  assert.equal(data.db.actions.size, 4);
  assert.equal(core.state.draft, null);
});
