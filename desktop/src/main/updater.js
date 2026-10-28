// Automatic updates from GitHub Releases (electron-updater).
// On launch it checks for a newer version and downloads it in the background,
// reporting progress to the UI. When the download is done it restarts and installs,
// unless the player is in champ select or a game: then it waits for "Restart to
// update" or installs when the app is closed.

const { app } = require('electron');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const RESTART_DELAY_MS = 2500;

function setupUpdater({ log, send, isBusy }) {
  let current = { state: 'idle', version: null, percent: 0 };
  const set = (next) => {
    current = { ...current, ...next };
    send(current);
  };
  // Nothing to update in development (npm start)
  if (!app.isPackaged) {
    return { state: () => current, install: () => {} };
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => log.info('updater', m),
    warn: (m) => log.info('updater', m),
    error: (m) => log.error('updater', m),
    debug: () => {},
  };

  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'idle' }));
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('error', (err) => {
    log.error('updater', err);
    // A failed check or download must not get in the way of using the app
    set({ state: current.state === 'ready' ? 'ready' : 'idle' });
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (isBusy()) return set({ state: 'ready', version: info.version, percent: 100 });
    set({ state: 'installing', version: info.version, percent: 100 });
    setTimeout(() => autoUpdater.quitAndInstall(true, true), RESTART_DELAY_MS);
  });

  const check = () => autoUpdater.checkForUpdates().catch((err) => log.error('updater', err));
  check();
  setInterval(() => {
    if (current.state === 'idle') check();
  }, CHECK_EVERY_MS);

  return {
    state: () => current,
    install: () => {
      if (current.state !== 'ready') return;
      set({ state: 'installing' });
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 300);
    },
  };
}

module.exports = { setupUpdater };
