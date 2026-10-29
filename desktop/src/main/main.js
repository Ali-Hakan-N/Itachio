// Electron entry point: opens the window, sets up the core, bridges IPC to the UI.

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { LcuConnector } = require('./lcu');
const { DataStore } = require('./data');
const { AppCore } = require('./core');
const { setupUpdater } = require('./updater');

// The app was called Flex Drafter: its data folder was %APPDATA%\FlexDrafter. On the first
// start as Itachio the saved sign-in and the log move over, so nobody has to sign in again,
// then the old data folder and the old update cache are removed.
(function moveOldData() {
  const now = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'FlexDrafter');
  try {
    if (!fs.existsSync(old)) return;
    if (!fs.existsSync(path.join(now, 'session.json'))) {
      fs.mkdirSync(now, { recursive: true });
      for (const [from, to] of [['session.json', 'session.json'], ['flex-drafter.log', 'itachio.log']]) {
        if (fs.existsSync(path.join(old, from))) fs.copyFileSync(path.join(old, from), path.join(now, to));
      }
    }
    fs.rmSync(old, { recursive: true, force: true });
    fs.rmSync(path.join(process.env.LOCALAPPDATA || '', 'flex-drafter-updater'), { recursive: true, force: true });
  } catch {
    /* worst case the player signs in once more, or an old folder stays */
  }
})();

let win = null;
let core = null;
let data = null;
let configError = null;

// Errors go to the console and to a log file in the app's data folder
const logFile = () => path.join(app.getPath('userData'), 'itachio.log');
const writeLog = (level, args) => {
  const line = `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}
`;
  try {
    fs.appendFileSync(logFile(), line);
  } catch {
    /* logging must never break the app */
  }
};
const fileLog = {
  error: (...args) => {
    console.error(...args);
    writeLog('ERROR', args);
  },
  info: (...args) => writeLog('INFO', args),
};

function loadConfig() {
  const candidates = [
    path.join(app.getAppPath(), 'config.json'),
    path.join(path.dirname(process.execPath), 'config.json'), // config placed next to the exe
  ];
  for (const file of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!cfg.supabaseUrl || !cfg.supabaseKey || cfg.supabaseUrl.includes('YOUR-PROJECT')) {
        throw new Error('supabaseUrl and supabaseKey must be filled in config.json');
      }
      return cfg;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        configError = err.message;
        return null;
      }
    }
  }
  configError = 'config.json not found. Copy config.example.json and fill it in.';
  return null;
}

// Champ select started: bring the app in front of the League client. Windows only lets a
// window take the foreground in some cases, so it is set always-on-top for a moment.
function bringToFront() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  win.moveTop();
  setTimeout(() => !win.isDestroyed() && win.setAlwaysOnTop(false), 400);
}

// After a hover from the app: hand the focus back to the League client, to lock in there.
// The client is asked to show itself, and the app gives up the focus (on Windows it goes
// to the window behind, which is the client after bringToFront).
function focusClient(lcu) {
  lcu.request('POST', '/riotclient/ux-show').catch(() => {});
  if (win && !win.isDestroyed()) win.blur();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0d1117',
    title: 'Itachio',
    icon: path.join(__dirname, '..', 'renderer', 'logo.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Open external links in the browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Every IPC call returns { ok, data } or { ok:false, error }
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function requireTeamMember() {
  const me = core.state.me;
  if (!me) throw new Error('Create your profile first');
  return me;
}

app.whenReady().then(async () => {
  const config = loadConfig();
  createWindow();

  const updater = setupUpdater({
    log: fileLog,
    send: (state) => send('update', state),
  });
  handle('update:get', () => updater.state());
  handle('update:install', () => updater.install());

  handle('app:init', async () => {
    if (!config) return { configError, version: app.getVersion() };
    const user = await data.getUser();
    return { configError: null, version: app.getVersion(), user: user ? { email: user.email } : null };
  });

  if (config) {
    data = new DataStore({
      url: config.supabaseUrl,
      key: config.supabaseKey,
      storageFile: path.join(app.getPath('userData'), 'session.json'),
    });
    const lcu = new LcuConnector({ installPath: config.leagueInstallPath });
    core = new AppCore({ lcu, data, log: fileLog });
    // The app comes to the front when champ select starts and whenever our ban or pick
    // turn starts; a hover from the app hands the focus back to the client (focusClient)
    let inChampSelect = false;
    let ourTurn = null;
    core.on('update', (partial) => {
      send('state', partial);
      if (!('draft' in partial)) return;
      const d = partial.draft;
      const turn = d && d.isOurTurn && d.turn ? `${d.turn.kind}:${d.turn.kind === 'ban' ? d.myBanActionId : d.myPickActionId}` : null;
      if ((d && !inChampSelect) || (turn && turn !== ourTurn)) bringToFront();
      inChampSelect = !!d;
      ourTurn = turn;
    });
    core.on('saved', (info) => send('saved', info));
    lcu.start();
  }

  handle('state:get', () => core.snapshot());
  handle('data:load', async () => {
    await core.loadUserData();
    return core.snapshot();
  });

  handle('auth:signIn', ({ email, password }) => data.signIn(email, password));
  handle('auth:signUp', ({ email, password }) => data.signUp(email, password));
  handle('auth:signOut', async () => {
    await data.signOut();
    core.clearUserData();
  });

  handle('profile:save', async (p) => {
    await data.saveProfile(p);
    await core.loadUserData();
    return core.snapshot();
  });
  handle('team:create', async (name) => {
    await data.createTeam(name);
    await core.refreshTeam();
    return core.snapshot();
  });
  handle('team:join', async (code) => {
    await data.joinTeam(code);
    await core.refreshTeam();
    return core.snapshot();
  });
  handle('team:kick', async (playerId) => {
    await data.kickMember(playerId);
    await core.refreshTeam();
    return core.snapshot();
  });
  handle('team:leave', async () => {
    await data.leaveTeam();
    await core.refreshTeam();
    return core.snapshot();
  });

  handle('pool:upsert', async (entry) => {
    const me = requireTeamMember();
    await data.upsertPool(me.id, entry);
    await core.refreshTeam();
  });
  handle('pool:remove', async (entry) => {
    const me = requireTeamMember();
    await data.removePool(me.id, entry);
    await core.refreshTeam();
  });

  handle('draft:hover', async (championId, kind) => {
    const what = kind === 'ban' ? 'ban' : 'pick';
    try {
      await core.hoverChampion(Number(championId), what);
      fileLog.info('hover', what, championId, 'ok');
      focusClient(core.lcu);
    } catch (err) {
      fileLog.error('hover', what, championId, err);
      throw err;
    }
  });

  handle('history:list', async () => {
    const me = core.state.me;
    return me?.team_id ? data.listHistory(me.team_id) : [];
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
