// Is the computer busy with a game? Training waits while it is.
//
// Busy means the League game is running, or the GPU's 3D engines are loaded above
// GPU_BUSY_PERCENT (Windows performance counters, the same data as the GPU graph in
// Task Manager). Browsing and video stay well below that.
// Outside Windows, or if the counters can't be read, the computer counts as free.

const { execFile } = require('node:child_process');

const GPU_BUSY_PERCENT = 40;
const GAME_PROCESSES = ['League of Legends'];

function powershell(command) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 20000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim()),
    );
  });
}

async function check() {
  if (process.platform !== 'win32') return { busy: false, load: null, game: false };
  const names = GAME_PROCESSES.map((n) => `'${n}'`).join(',');
  const out = await powershell(
    "$s = (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -SampleInterval 3 -MaxSamples 1 -ErrorAction Stop).CounterSamples; " +
      "$g = [bool](Get-Process -Name " + names + " -ErrorAction SilentlyContinue); " +
      "'{0} {1}' -f [math]::Round(($s | Measure-Object CookedValue -Sum).Sum), $g",
  );
  const [load, game] = out.split(/\s+/);
  const gpu = Number(load) || 0;
  const playing = game === 'True';
  return { busy: playing || gpu >= GPU_BUSY_PERCENT, load: gpu, game: playing };
}

/** { busy, load, game }; never throws */
async function busyNow(log = () => {}) {
  try {
    return await check();
  } catch (err) {
    log(`could not read GPU load (${err.message}); training anyway`);
    return { busy: false, load: null, game: false };
  }
}

const describe = ({ load, game }) => (game ? 'League game is running' : `GPU 3D load ${load}%`);

const GATE_POLL_MS = 60_000;
const GATE_FREE_MS = 60_000;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A gate the collector passes before every request: free passes at once (the answer is
 * kept GATE_FREE_MS), busy waits here, checking every GATE_POLL_MS, until the computer is
 * free or the run is stopping. One check at a time, however many callers wait.
 */
function makeGate({ log = () => {}, isStopped = () => false, probe = busyNow, sleep = sleepMs, pollMs = GATE_POLL_MS, freeMs = GATE_FREE_MS } = {}) {
  let freeUntil = 0;
  let pending = null;
  const wait = async () => {
    let paused = false;
    for (;;) {
      const state = await probe();
      if (!state.busy || isStopped()) {
        if (paused) log('collector: computer is free, resuming');
        freeUntil = Date.now() + freeMs;
        return;
      }
      if (!paused) log(`collector: paused while the computer is busy (${describe(state)})`);
      paused = true;
      await sleep(pollMs);
    }
  };
  return async () => {
    if (Date.now() < freeUntil) return;
    pending ||= wait().finally(() => (pending = null));
    await pending;
  };
}

module.exports = { busyNow, describe, makeGate, GPU_BUSY_PERCENT };
