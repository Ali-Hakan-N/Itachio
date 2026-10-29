// End to end: mock LCU -> real LcuConnector -> AppCore -> fake database
const test = require('node:test');
const assert = require('node:assert/strict');
const { startMockLcu, SCRIPT, PICKABLE } = require('./mock-lcu');
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
    loadStats: async () => ({ meta: [], synergy: [], matchup: [] }),
    loadModel: async () => null,
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

test('the mock LCU scenario is recorded from start to finish', async () => {
  const mock = await startMockLcu({ stepMs: 25, quiet: true });
  process.env.LCU_LOCKFILE = mock.lockfilePath;
  const lcu = new LcuConnector({ pollMs: 50 });
  const data = fakeData();
  const core = new AppCore({ lcu, data, log: { error: () => {} } });
  await core.loadUserData();

  const seenPhases = [];
  let maxCompleted = 0;
  let pickable = null;
  core.on('update', (p) => {
    if (p.lcu) seenPhases.push(p.lcu.phase);
    if (p.draft) maxCompleted = Math.max(maxCompleted, p.draft.completed.length);
    if (p.pickable) pickable = p.pickable;
  });
  const saved = new Promise((r) => core.on('saved', r));

  lcu.start();
  await mock.finished;
  await saved;
  await core.queue;
  lcu.stop();
  await mock.close();

  // Draft was followed live, pickable champions came from the client
  assert.equal(maxCompleted, 20);
  assert.deepEqual(pickable, PICKABLE);
  assert.ok(seenPhases.includes('ChampSelect') && seenPhases.includes('InProgress') && seenPhases.includes('EndOfGame'));

  // Account was linked
  assert.ok(data.calls.some((c) => c[0] === 'link' && c[1] === 'mock-puuid-local' && c[2] === 'Deneme#TR1'));

  // One draft row for the game, 20 actions
  assert.equal(data.db.drafts.size, 1);
  assert.equal(data.db.actions.size, 20);
  const myPick = data.db.actions.get('ally:pick:3');
  assert.equal(myPick.champion_id, 103);
  assert.equal(myPick.role, 'middle');
  assert.equal(myPick.player_id, 'p-local');
  assert.equal(data.db.actions.get('ally:pick:2').player_id, 'p-jungle');
  assert.equal(data.db.actions.get('enemy:pick:1').player_id, null);

  // Game started -> finished, result is a win
  const draft = [...data.db.drafts.values()][0];
  assert.equal(draft.status, 'finished');
  assert.equal(draft.result, 'win');
  assert.ok(data.calls.some((c) => c[0] === 'updateDraft' && c[2] === 'played'));

  // Match result written once and linked to the draft
  assert.equal(data.db.results.length, 1);
  assert.equal(data.db.results[0].draft_id, draft.id);
  assert.equal(data.db.results[0].kills, 9);
});

test('dodge: returning to lobby before the game marks the draft dodged', async () => {
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

test('hover: clicking a recommendation sets the hover in the client', async () => {
  const mock = await startMockLcu({ stepMs: 400, quiet: true });
  process.env.LCU_LOCKFILE = mock.lockfilePath;
  const lcu = new LcuConnector({ pollMs: 50 });
  const core = new AppCore({ lcu, data: fakeData(), log: { error: () => {} } });
  await core.loadUserData();
  const firstDraft = new Promise((r) => core.on('update', (p) => p.draft && r()));
  lcu.start();
  await firstDraft;

  const hovered = new Promise((r) =>
    core.on('update', (p) => p.draft && p.draft.ally.find((x) => x.isLocal).hoverId === 7 && r()),
  );
  await core.hoverChampion(7);
  await hovered;
  assert.deepEqual(mock.patches, [{ actionId: 11, championId: 7 }]);
  lcu.stop();
  await mock.close();
});

test('hover: refused once our pick is locked', async () => {
  const lcu = new (require('node:events').EventEmitter)();
  lcu.get = async () => null;
  lcu.request = async () => assert.fail('no request expected');
  const core = new AppCore({ lcu, data: fakeData(), log: { error: () => {} } });
  await core.loadUserData();
  const { buildSession } = require('./mock-lcu');
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: buildSession(SCRIPT.length), eventType: 'Update' });
  await assert.rejects(core.hoverChampion(7), /No pick/);
});

test('pick score: each teammate pick is saved with its score at lock time', async () => {
  const lcu = new (require('node:events').EventEmitter)();
  lcu.get = async () => null;
  const data = fakeData();
  data.loadModel = async () => ({
    champ: { '103:2': [0.2, 900, 1, 0.02], '86:0': [0, 900, 1, 0.02], '254:1': [0, 900, 1, 0.02] },
    off: [0, 0, 0, 0, 0], tags: {}, syn: [], vs: [],
  });
  const core = new AppCore({ lcu, data, log: { error: () => {} } });
  await core.loadUserData();
  await core.refreshTeam();
  const { buildSession } = require('./mock-lcu');
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: buildSession(SCRIPT.length), eventType: 'Update' });
  await core.queue;
  const mine = data.db.actions.get('ally:pick:3'); // Ahri, local player
  assert.equal(typeof mine.score, 'number');
  assert.ok(mine.score > 50);
  assert.equal(data.db.actions.get('enemy:pick:1').score, null); // enemies are not scored
});
