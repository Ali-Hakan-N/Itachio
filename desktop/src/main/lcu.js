// League Client (LCU) connection.
// - Finds the client (port + password from the running process or the lockfile)
// - Subscribes to events over WebSocket
// - Makes REST requests
// Reconnects on its own when the client closes and reopens.

const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const WebSocket = require('ws');

// The LCU uses a local self-signed certificate. This agent is only used
// for LCU requests to 127.0.0.1.
const localAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const DEFAULT_INSTALL_PATHS = [
  'C:\\Riot Games\\League of Legends',
  '/Applications/League of Legends.app/Contents/LoL',
];

const SUBSCRIPTIONS = [
  'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
  'OnJsonApiEvent_lol-champ-select_v1_session',
  'OnJsonApiEvent_lol-end-of-game_v1_eog-stats-block',
];

function parseLockfile(text) {
  // Format: LeagueClient:<pid>:<port>:<password>:<protocol>
  const parts = text.trim().split(':');
  if (parts.length < 5) return null;
  const port = Number(parts[2]);
  if (!port) return null;
  return { port, password: parts[3], protocol: parts[4] || 'https' };
}

function parseCommandLine(cmd) {
  const port = /--app-port=(\d+)/.exec(cmd);
  const token = /--remoting-auth-token=([\w-]+)/.exec(cmd);
  if (!port || !token) return null;
  return { port: Number(port[1]), password: token[1], protocol: 'https' };
}

function findViaProcess() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine",
      ],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => resolve(err || !stdout ? null : parseCommandLine(stdout)),
    );
  });
}

function findViaLockfile(installPath) {
  const candidates = [];
  if (process.env.LCU_LOCKFILE) candidates.push(process.env.LCU_LOCKFILE);
  if (installPath) candidates.push(path.join(installPath, 'lockfile'));
  for (const p of DEFAULT_INSTALL_PATHS) candidates.push(path.join(p, 'lockfile'));
  for (const file of candidates) {
    try {
      const creds = parseLockfile(fs.readFileSync(file, 'utf8'));
      if (creds) return creds;
    } catch {
      /* not there, try the next one */
    }
  }
  return null;
}

class LcuConnector extends EventEmitter {
  constructor({ installPath, pollMs = 4000, host = '127.0.0.1' } = {}) {
    super();
    this.installPath = installPath;
    this.pollMs = pollMs;
    this.host = host;
    this.creds = null;
    this.ws = null;
    this.connected = false;
    this.stopped = true;
    this.timer = null;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#tick();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) this.ws.terminate();
    this.ws = null;
    this.#setConnected(false);
  }

  async #tick() {
    if (this.stopped || this.connected) return;
    // The lockfile only exists while the client runs. One given via env (tests) wins.
    const creds = findViaLockfile(this.installPath) || (await findViaProcess());
    if (creds) {
      try {
        await this.#connect(creds);
        return;
      } catch {
        /* the client may be starting, try again */
      }
    }
    this.timer = setTimeout(() => this.#tick(), this.pollMs);
  }

  #connect(creds) {
    return new Promise((resolve, reject) => {
      const auth = 'Basic ' + Buffer.from(`riot:${creds.password}`).toString('base64');
      const ws = new WebSocket(`wss://${this.host}:${creds.port}/`, {
        headers: { Authorization: auth },
        rejectUnauthorized: false,
      });
      let opened = false;

      ws.on('open', () => {
        opened = true;
        this.ws = ws;
        this.creds = creds;
        for (const ev of SUBSCRIPTIONS) ws.send(JSON.stringify([5, ev]));
        this.#setConnected(true);
        resolve();
      });

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        // WAMP event message: [8, "<subscription>", { data, eventType, uri }]
        if (Array.isArray(msg) && msg[0] === 8 && msg[2]) {
          this.emit('event', msg[2]);
        }
      });

      const onDown = (err) => {
        if (!opened) return reject(err || new Error('closed'));
        if (this.ws === ws) this.ws = null;
        this.#setConnected(false);
        if (!this.stopped) this.timer = setTimeout(() => this.#tick(), this.pollMs);
      };
      ws.on('error', (err) => {
        if (!opened) reject(err);
      });
      ws.on('close', () => onDown());
    });
  }

  #setConnected(v) {
    if (this.connected === v) return;
    this.connected = v;
    if (!v) this.creds = null;
    this.emit('status', { connected: v });
  }

  // REST request. Returns null on 404 and similar.
  request(method, urlPath, body) {
    const creds = this.creds;
    if (!creds) return Promise.reject(new Error('LCU not connected'));
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: this.host,
          port: creds.port,
          path: urlPath,
          method,
          agent: localAgent,
          headers: {
            Authorization: 'Basic ' + Buffer.from(`riot:${creds.password}`).toString('base64'),
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          },
          timeout: 8000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 404 || res.statusCode === 204) return resolve(null);
            if (res.statusCode >= 400) {
              let detail = '';
              try {
                detail = JSON.parse(text).message || '';
              } catch {
                detail = text.slice(0, 200);
              }
              return reject(new Error(`LCU ${method} ${urlPath} -> ${res.statusCode}${detail ? `: ${detail}` : ''}`));
            }
            try {
              resolve(text ? JSON.parse(text) : null);
            } catch {
              resolve(text);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('LCU timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  get(urlPath) {
    return this.request('GET', urlPath);
  }
}

module.exports = { LcuConnector, parseLockfile, parseCommandLine };
