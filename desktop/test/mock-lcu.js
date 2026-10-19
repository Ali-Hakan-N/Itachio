// Sahte League Client (LCU). Gerçek oyun açmadan uygulamayı denemek için.
//
// Kullanım (ayrı bir terminalde):
//   npm run dev:mock
// Sonra uygulamayı yazdığı LCU_LOCKFILE ile başlatın:
//   Windows (PowerShell):  $env:LCU_LOCKFILE="<yol>"; npm start
//   macOS/Linux:           LCU_LOCKFILE=<yol> npm start
//
// Senaryo: turnuva draft'ı (mavi taraf, sen orta koridordasın) -> oyun -> maç sonu.

const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');

const LOCAL_PUUID = 'mock-puuid-local';
const POSITIONS = ['top', 'jungle', 'middle', 'bottom', 'utility'];

// [aktör hücresi, tür, şampiyon]. Mavi: 0-4, kırmızı: 5-9
const SCRIPT = [
  [0, 'ban', 238], [5, 'ban', 157], [1, 'ban', 875], [6, 'ban', 99], [2, 'ban', 777], [7, 'ban', 234],
  [0, 'pick', 86], [5, 'pick', 64], [6, 'pick', 61], [1, 'pick', 254], [2, 'pick', 103], [7, 'pick', 222],
  [8, 'ban', 81], [3, 'ban', 104], [9, 'ban', 141], [4, 'ban', 122],
  [8, 'pick', 111], [3, 'pick', 145], [4, 'pick', 412], [9, 'pick', 58],
];
const GAME_ID = 7000000001;

function buildSession(done) {
  const champOf = new Map();
  const myTeamBans = [];
  const theirTeamBans = [];
  SCRIPT.slice(0, done).forEach(([cell, type, champ]) => {
    if (type === 'pick') champOf.set(cell, champ);
    else (cell < 5 ? myTeamBans : theirTeamBans).push(champ);
  });
  const current = SCRIPT[done];

  const actions = SCRIPT.map(([cell, type, champ], i) => [
    {
      id: i + 1,
      actorCellId: cell,
      // Rakibin sıradaki seçimi kilitlenene kadar görünmez
      championId: i < done || (i === done && cell < 5) ? champ : 0,
      completed: i < done,
      isAllyAction: cell < 5,
      isInProgress: i === done,
      type,
    },
  ]);

  const myTeam = [0, 1, 2, 3, 4].map((cell) => {
    const hovering = current && current[0] === cell && current[1] === 'pick';
    return {
      cellId: cell,
      championId: champOf.get(cell) || (hovering ? current[2] : 0),
      championPickIntent: cell === 2 && !champOf.has(2) ? 103 : 0,
      assignedPosition: POSITIONS[cell],
      puuid: cell === 2 ? LOCAL_PUUID : `mock-puuid-${cell}`,
      team: 1,
    };
  });
  const theirTeam = [5, 6, 7, 8, 9].map((cell) => ({
    cellId: cell,
    championId: champOf.get(cell) || 0,
    assignedPosition: '',
    team: 2,
  }));

  return {
    gameId: GAME_ID,
    localPlayerCellId: 2,
    myTeam,
    theirTeam,
    actions,
    bans: { myTeamBans, theirTeamBans, numBans: 10 },
    timer: {
      phase: done < SCRIPT.length ? 'BAN_PICK' : 'FINALIZATION',
      adjustedTimeLeftInPhase: done < SCRIPT.length ? 27000 : 60000,
    },
  };
}

const EOG_BLOCK = {
  gameId: GAME_ID,
  gameLength: 1834,
  queueType: 'RANKED_FLEX_SR',
  localPlayer: {
    championId: 103,
    puuid: LOCAL_PUUID,
    stats: {
      CHAMPIONS_KILLED: 9, NUM_DEATHS: 2, ASSISTS: 11, MINIONS_KILLED: 214, NEUTRAL_MINIONS_KILLED: 12,
      GOLD_EARNED: 14230, TOTAL_DAMAGE_DEALT_TO_CHAMPIONS: 31240, VISION_SCORE: 27, WIN: 1,
    },
  },
  teams: [
    { isPlayerTeam: true, isWinningTeam: true, players: [] },
    { isPlayerTeam: false, isWinningTeam: false, players: [] },
  ],
};

async function startMockLcu({ stepMs = 1500, port = 0, loop = false, quiet = false } = {}) {
  const pems = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], { days: 30, keySize: 2048 });
  const password = 'mock-password';
  const expectedAuth = 'Basic ' + Buffer.from(`riot:${password}`).toString('base64');
  const log = (...a) => !quiet && console.log('[sahte LCU]', ...a);

  const state = { phase: 'Lobby', done: 0, inChampSelect: false, eog: null };

  const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401).end();
      return;
    }
    const sendJson = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    switch (req.url) {
      case '/lol-summoner/v1/current-summoner':
        return sendJson({ puuid: LOCAL_PUUID, gameName: 'Deneme', tagLine: 'TR1', displayName: 'Deneme' });
      case '/lol-gameflow/v1/gameflow-phase':
        return sendJson(state.phase);
      case '/lol-champ-select/v1/session':
        return state.inChampSelect ? sendJson(buildSession(state.done)) : res.writeHead(404).end();
      case '/lol-end-of-game/v1/eog-stats-block':
        return state.eog ? sendJson(state.eog) : res.writeHead(404).end();
      default:
        res.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({
    server,
    verifyClient: (info) => info.req.headers.authorization === expectedAuth,
  });
  const clients = new Set();
  const broadcast = (uri, data, eventType = 'Update') => {
    const name = {
      '/lol-gameflow/v1/gameflow-phase': 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
      '/lol-champ-select/v1/session': 'OnJsonApiEvent_lol-champ-select_v1_session',
      '/lol-end-of-game/v1/eog-stats-block': 'OnJsonApiEvent_lol-end-of-game_v1_eog-stats-block',
    }[uri];
    const msg = JSON.stringify([8, name, { data, eventType, uri }]);
    for (const c of clients) if (c.subs?.has(name)) c.send(msg);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let running = false;
  let closed = false;
  let resolveDone;
  const finished = new Promise((r) => (resolveDone = r));

  const setPhase = (p) => {
    state.phase = p;
    log('aşama:', p);
    broadcast('/lol-gameflow/v1/gameflow-phase', p);
  };

  async function runScenario() {
    if (running) return;
    running = true;
    do {
      state.eog = null;
      setPhase('ChampSelect');
      state.inChampSelect = true;
      state.done = 0;
      broadcast('/lol-champ-select/v1/session', buildSession(0), 'Create');
      for (let i = 1; i <= SCRIPT.length && !closed; i += 1) {
        await sleep(stepMs);
        state.done = i;
        const [cell, type, champ] = SCRIPT[i - 1];
        log(`${cell < 5 ? 'mavi' : 'kırmızı'} ${type} -> ${champ}`);
        broadcast('/lol-champ-select/v1/session', buildSession(i));
      }
      await sleep(stepMs);
      state.inChampSelect = false;
      broadcast('/lol-champ-select/v1/session', null, 'Delete');
      setPhase('GameStart');
      await sleep(stepMs / 2);
      setPhase('InProgress');
      await sleep(stepMs * 2);
      setPhase('WaitingForStats');
      state.eog = EOG_BLOCK;
      setPhase('EndOfGame');
      broadcast('/lol-end-of-game/v1/eog-stats-block', EOG_BLOCK);
      await sleep(stepMs * 3);
      setPhase('Lobby');
      if (loop) await sleep(stepMs * 3);
    } while (loop && !closed);
    running = false;
    resolveDone();
  }

  wss.on('connection', (ws) => {
    ws.subs = new Set();
    clients.add(ws);
    ws.on('message', (raw) => {
      try {
        const [op, name] = JSON.parse(raw.toString());
        if (op === 5) ws.subs.add(name);
        if (ws.subs.size >= 3) setTimeout(runScenario, stepMs);
      } catch {
        /* yok say */
      }
    });
    ws.on('close', () => clients.delete(ws));
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actualPort = server.address().port;
  const lockfilePath = path.join(os.tmpdir(), `mock-lcu-lockfile-${process.pid}`);
  fs.writeFileSync(lockfilePath, `LeagueClient:${process.pid}:${actualPort}:${password}:https`);
  log('çalışıyor, port', actualPort);

  return {
    port: actualPort,
    lockfilePath,
    localPuuid: LOCAL_PUUID,
    gameId: GAME_ID,
    finished,
    close: async () => {
      closed = true;
      for (const c of clients) c.terminate();
      wss.close();
      await new Promise((r) => server.close(r));
      try {
        fs.unlinkSync(lockfilePath);
      } catch {
        /* zaten silinmiş */
      }
    },
  };
}

module.exports = { startMockLcu, buildSession, SCRIPT, EOG_BLOCK, GAME_ID, LOCAL_PUUID };

if (require.main === module) {
  const stepMs = Number(process.env.MOCK_STEP_MS || 1500);
  startMockLcu({ stepMs, loop: true }).then((m) => {
    console.log('\nUygulamayı şu ortam değişkeniyle başlatın:');
    console.log(`  LCU_LOCKFILE=${m.lockfilePath}\n`);
    const stop = () => m.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
