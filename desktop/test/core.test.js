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

test('hover: a ban suggestion is hovered on our ban action', async () => {
  const lcu = new (require('node:events').EventEmitter)();
  lcu.get = async () => null;
  const sent = [];
  lcu.request = async (method, path, body) => sent.push([method, path, body]);
  const core = new AppCore({ lcu, data: fakeData(), log: { error: () => {} } });
  await core.loadUserData();
  const { buildSession } = require('./mock-lcu');
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: buildSession(2), eventType: 'Update' });
  await core.hoverChampion(157, 'ban');
  assert.deepEqual(sent, [['PATCH', '/lol-champ-select/v1/session/actions/5', { championId: 157 }]]);
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: buildSession(5), eventType: 'Update' });
  await assert.rejects(core.hoverChampion(157, 'ban'), /No ban/);
});

test('model: a newer model is taken between drafts, never during one', async () => {
  const lcu = new (require('node:events').EventEmitter)();
  lcu.get = async () => null;
  const data = fakeData();
  let latest = 1;
  data.loadModel = async () => ({ snapshotId: latest, champ: {} });
  data.latestModelId = async () => latest;
  const core = new AppCore({ lcu, data, log: { error: () => {} } });
  await core.loadUserData();
  core.clearUserData(); // stops the timer; refreshModel is called by hand
  assert.equal(core.state.model.snapshotId, 1);
  assert.equal(await core.refreshModel(), false); // nothing new
  latest = 2;
  const { buildSession } = require('./mock-lcu');
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: buildSession(3), eventType: 'Update' });
  assert.equal(await core.refreshModel(), false); // in champ select: wait
  assert.equal(core.state.model.snapshotId, 1);
  lcu.emit('event', { uri: '/lol-gameflow/v1/gameflow-phase', data: 'WaitingForStats' }); // the game is over
  assert.equal(await core.refreshModel(), true);
  assert.equal(core.state.model.snapshotId, 2);
});

test('model: the newest model is taken when champ select starts, then kept for the draft', async () => {
  const lcu = new (require('node:events').EventEmitter)();
  lcu.get = async () => null;
  const data = fakeData();
  let latest = 1;
  data.loadModel = async () => ({ snapshotId: latest, champ: {} });
  data.latestModelId = async () => latest;
  const core = new AppCore({ lcu, data, log: { error: () => {}, info: () => {} } });
  await core.loadUserData();
  core.clearUserData();
  latest = 2; // uploaded just before the draft
  const { buildSession } = require('./mock-lcu');
  const updated = new Promise((r) => core.on('update', (p) => p.model && r()));
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: buildSession(1), eventType: 'Update' });
  await updated;
  assert.equal(core.state.model.snapshotId, 2);
  latest = 3; // uploaded during the draft: not taken
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: buildSession(2), eventType: 'Update' });
  assert.equal(await core.refreshModel(), false);
  assert.equal(core.state.model.snapshotId, 2);
});

test('the draft stays on screen during the game and goes when it ends', async () => {
  const lcu = new (require('node:events').EventEmitter)();
  lcu.get = async () => null;
  const core = new AppCore({ lcu, data: fakeData(), log: { error: () => {}, info: () => {} } });
  await core.loadUserData();
  const { buildSession } = require('./mock-lcu');
  lcu.emit('event', { uri: '/lol-gameflow/v1/gameflow-phase', data: 'ChampSelect' });
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: buildSession(SCRIPT.length), eventType: 'Update' });
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', eventType: 'Delete' });
  lcu.emit('event', { uri: '/lol-gameflow/v1/gameflow-phase', data: 'GameStart' });
  lcu.emit('event', { uri: '/lol-gameflow/v1/gameflow-phase', data: 'InProgress' });
  await core.queue;
  assert.ok(core.state.draft, 'still shown in game');
  lcu.emit('event', { uri: '/lol-gameflow/v1/gameflow-phase', data: 'WaitingForStats' });
  assert.equal(core.state.draft, null);
});

// A core in champ select with a build for our champion; sent: what went to the client
async function buildCore(settings) {
  const lcu = new (require('node:events').EventEmitter)();
  const sent = [];
  lcu.get = async (path) => {
    if (path === '/lol-perks/v1/pages') return [{ id: 7, name: 'My page', isEditable: true, current: true }];
    if (path === '/lol-perks/v1/inventory') return { ownedPageCount: 2 };
    if (path === '/lol-summoner/v1/current-summoner') return { summonerId: 42 };
    if (path.startsWith('/lol-item-sets/')) return { accountId: 1, itemSets: [{ uid: 'mine', title: 'Mine' }], timestamp: 1 };
    if (path === '/lol-champ-select/v1/session') return { localPlayerCellId: 2, myTeam: [{ cellId: 2, spell1Id: 14, spell2Id: 4 }] };
    return null;
  };
  lcu.request = async (method, path, body) => sent.push([method, path, body]);
  const data = fakeData();
  const build = { bucket: 'any', runes: { primary: 8100, sub: 8200, perks: [8112, 8139, 8138, 8135, 8226, 8237, 5008, 5008, 5001] }, items: { core: [6655, 3157], more: [3089], boots: 3020, start: [1055, 2003] }, spells: [4, 14] };
  data.loadBuilds = async () => ({ '103:middle:any': build });
  data.loadDamage = async () => null;
  data.loadGameData = async () => null;
  const core = new AppCore({ lcu, data, log: { error: () => {}, info: () => {} }, settings });
  await core.loadUserData();
  await new Promise((r) => setTimeout(r, 20)); // builds load in the background
  const { buildSession } = require('./mock-lcu');
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: buildSession(SCRIPT.length), eventType: 'Update' });
  await new Promise((r) => setTimeout(r, 50));
  return { lcu, core, sent, build, buildSession };
}

test('build: with both auto options on, once all ten picks are locked, runes, items and spells go to the client once', async () => {
  const { lcu, core, sent, build, buildSession } = await buildCore({ autoRunes: true, autoItems: true });
  const post = sent.find((x) => x[1] === '/lol-perks/v1/pages' && x[0] === 'POST');
  assert.ok(post, 'a new rune page (a free page is left)');
  assert.deepEqual(post[2].selectedPerkIds, build.runes.perks);
  const sets = sent.find((x) => x[1] === '/lol-item-sets/v1/item-sets/42/sets');
  assert.ok(sets[2].itemSets.some((x) => x.uid === 'mine'), 'other item sets kept');
  const itemSet = sets[2].itemSets.find((x) => x.associatedChampions?.[0] === 103);
  assert.ok(itemSet.blocks.some((x) => x.type === 'Starting Items' && x.items.map((i) => i.id).join(',') === '1055,2003'));
  assert.ok(itemSet.blocks.some((x) => x.type === 'Boots' && x.items[0].id === '3020'));
  assert.ok(itemSet.blocks.some((x) => x.type === 'Core' && x.items[0].id === '6655'));
  const spells = sent.find((x) => x[1] === '/lol-champ-select/v1/session/my-selection');
  assert.deepEqual(spells[2], { spell1Id: 14, spell2Id: 4 }, 'Flash stays on its key');
  const count = sent.length;
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: buildSession(SCRIPT.length), eventType: 'Update' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, count, 'only once per game');
  assert.deepEqual(core.state.applied.parts, { runes: true, items: true, spells: true });
});

test('build: nothing goes to the client on its own unless the options ask for it', async () => {
  const off = await buildCore({});
  assert.equal(off.sent.length, 0);
  assert.ok(off.core.state.currentBuild, 'the build is still shown, to apply by hand');
  const items = await buildCore({ autoItems: true });
  assert.ok(items.sent.some((x) => x[1].startsWith('/lol-item-sets/')));
  assert.ok(!items.sent.some((x) => x[1].startsWith('/lol-perks/') || x[1].endsWith('/my-selection')));
});

test('build: starting items and boots fall back from the general build when a damage bucket lacks them', async () => {
  const { core, build } = await buildCore({});
  core.state.damage = { magic: {}, thresholds: [0.3, 0.4] };
  core.state.builds['103:middle:ap'] = {
    ...build,
    bucket: 'ap',
    items: { ...build.items, start: null, boots: null },
  };

  const result = core.buildFor();

  assert.equal(result.bucket, 'ap');
  assert.deepEqual(result.build.items.start, [1055, 2003]);
  assert.equal(result.build.items.boots, 3020);
});

test('last game: the summary keeps the final draft and every player\'s numbers until the next champ select', async () => {
  const lcu = new (require('node:events').EventEmitter)();
  lcu.get = async () => null;
  const core = new AppCore({ lcu, data: fakeData(), log: { error: () => {}, info: () => {} } });
  await core.loadUserData();
  const { buildSession, EOG_BLOCK } = require('./mock-lcu');
  lcu.emit('event', { uri: '/lol-gameflow/v1/gameflow-phase', data: 'ChampSelect' });
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: buildSession(SCRIPT.length), eventType: 'Update' });
  lcu.emit('event', { uri: '/lol-gameflow/v1/gameflow-phase', data: 'InProgress' });
  lcu.emit('event', { uri: '/lol-gameflow/v1/gameflow-phase', data: 'WaitingForStats' });
  const block = { ...EOG_BLOCK, teams: [
    { isPlayerTeam: true, isWinningTeam: true, players: [{ championId: 103, stats: { CHAMPIONS_KILLED: 9, NUM_DEATHS: 2, ASSISTS: 11, MINIONS_KILLED: 200 } }] },
    { isPlayerTeam: false, isWinningTeam: false, players: [{ championId: 64, stats: { CHAMPIONS_KILLED: 1 } }] },
  ] };
  lcu.emit('event', { uri: '/lol-end-of-game/v1/eog-stats-block', data: block });
  await core.queue;
  const g = core.state.lastGame;
  assert.equal(g.win, true);
  assert.equal(g.draft.ally.find((p) => p.isLocal).championId, 103);
  assert.deepEqual(g.players.find((p) => p.championId === 103), { side: 'ally', championId: 103, kills: 9, deaths: 2, assists: 11, cs: 200, gold: null, damage: null });
  lcu.emit('event', { uri: '/lol-champ-select/v1/session', data: { ...buildSession(1), gameId: 99 }, eventType: 'Update' });
  assert.equal(core.state.lastGame, null);
});

test('situational items: picked from the champion\'s choices by what they add against this enemy team', () => {
  const { situationalItems } = require('../src/main/core');
  const sit = {
    features: ['magic', 'heal', 'cc', 'assassin'],
    center: [0, 0, 0, 0],
    // 10 and 11 (healers, one magic), 20 and 21 (physical)
    profile: { 10: [1, 2, 0, 0], 11: [-1, 2, 0, 0], 20: [-1, 0, 0, 0], 21: [-1, 0, 0, 0] },
    items: { 3165: [0, 0.01, 0, 0], 3075: [-0.01, 0.005, 0, 0], 4401: [0.012, 0, 0, 0], 3031: [0, 0.05, 0, 0] },
  };
  const build = { items: { core: [3031], pool: [3031, 3165, 3075, 4401] } };
  const healers = situationalItems(build, [10, 11, 20, 21, 20], sit);
  assert.deepEqual(healers.map((x) => x.id), [3075, 3165], 'core items are not repeated; magic resist is not worth it');
  assert.deepEqual(healers[0].reasons, ['physical damage', 'healing']);
  assert.deepEqual(situationalItems(build, [20, 21, 20, 21, 20], sit).map((x) => x.id), [3075]);
  assert.deepEqual(situationalItems(build, [20], null), []);
});
