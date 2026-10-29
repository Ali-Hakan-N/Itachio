// Stores single matches on this computer, trains the win model and uploads it.
//
// Matches go to data/matches/<patch>.jsonl (one compact match per line). Only the
// trained weights go to Supabase (model_snapshots), as one JSON document.
//
// Scores in the app are on a fixed 0-100 scale, the same for every draft:
//   score = 50 + 50 × tanh(pointsPerLogit × (logit - center) / 50)
// center makes an average champion 50. pointsPerLogit is set from the data so one
// standard deviation of champion strength is SCORE_SD points: typical champions land
// around 35-65, strong ones 75-85, and tanh keeps even extreme drafts off 0 and 100.

const fs = require('node:fs');
const path = require('node:path');
const { ROLES, SHARE_FLOOR, toCompact, roleShares } = require('./features');
const { Worker } = require('node:worker_threads');
const idle = require('./idle');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'matches');
const SCORE_SD = 15;
const POINTS_PER_LOGIT = 75; // fallback when there is too little data to measure the spread
const SCALE_MIN_GAMES = 100;
const PRUNE = 0.002; // pair weights smaller than this are left out of the upload
const MIN_MATCHES = 2000;
const MAX_TRAIN_MATCHES = 150000; // newest matches only, keeps training memory around 500 MB
const KEEP_SNAPSHOTS = 3;
const IDLE_CHECK_MS = 60_000; // while waiting for a free computer
const BUSY_POLL_MS = 20_000; // while training: stop if a game starts

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const fileFor = (patch) => path.join(DATA_DIR, `${patch.replace(/[^0-9.]/g, '')}.jsonl`);

/** Appends parsed matches (riot/parse.js) with complete roles; returns how many were stored */
function storeMatches(patch, parsed) {
  const lines = parsed.map(toCompact).filter(Boolean).map((m) => JSON.stringify(m));
  if (!lines.length) return 0;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(fileFor(patch), `${lines.join('\n')}\n`);
  return lines.length;
}

function loadMatches(patch) {
  const file = fileFor(patch);
  if (!fs.existsSync(file)) return [];
  const seen = new Set();
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    } catch {
      /* a line cut off by a crash: skip it */
    }
  }
  return out;
}

/**
 * The model as the app reads it. Roles are indexes into ROLES.
 *   champ: { "<champ>:<role>": [weight, games, share] }
 *   off:   weight per role for -ln(share)
 *   syn:   [[a, ra, b, rb, weight]]   same team, a:ra before b:rb
 *   vs:    [[a, ra, b, rb, weight]]   a against b; b against a is -weight
 *   ts/tv: { "<classA>:<classB>": weight }   classes sorted; tv is classA against classB
 */
function exportModel(model, { share, games, tags, patch, matches }) {
  const champ = {};
  const off = new Array(5).fill(0);
  const syn = [];
  const vs = [];
  const ts = {};
  const tv = {};
  model.keys.forEach((key, i) => {
    const w = round(model.w[i], 5);
    const p = key.split(':');
    if (p[0] === 'c') champ[`${p[1]}:${p[2]}`] = [w, games.get(`${p[1]}:${p[2]}`) || 0, round(share.get(`${p[1]}:${p[2]}`) || 0, 4)];
    else if (p[0] === 'o') off[Number(p[1])] = w;
    else if (p[0] === 's' && Math.abs(w) >= PRUNE) syn.push([+p[1], +p[2], +p[3], +p[4], w]);
    else if (p[0] === 'v' && Math.abs(w) >= PRUNE) vs.push([+p[1], +p[2], +p[3], +p[4], w]);
    else if (p[0] === 'ts') ts[`${p[1]}:${p[2]}`] = w;
    else if (p[0] === 'tv') tv[`${p[1]}:${p[2]}`] = w;
  });
  // Scale: spread of champion strength (with the off-role term) among well-played picks
  const bases = [];
  for (const [key, [w, n, s]] of Object.entries(champ)) {
    if (n < SCALE_MIN_GAMES) continue;
    bases.push(w + off[Number(key.split(':')[1])] * -Math.log(Math.max(s, SHARE_FLOOR)));
  }
  const mean = bases.length ? bases.reduce((a, b) => a + b, 0) / bases.length : 0;
  const sd = bases.length > 1 ? Math.sqrt(bases.reduce((a, b) => a + (b - mean) ** 2, 0) / bases.length) : 0;
  const pointsPerLogit = sd > 0 ? Math.min(Math.max(SCORE_SD / sd, 40), 600) : POINTS_PER_LOGIT;

  const tagOf = {};
  for (const key of Object.keys(champ)) {
    const id = Number(key.split(':')[0]);
    tagOf[id] = tags.get(id) || 'None';
  }
  return {
    version: 1,
    patch,
    trainedAt: new Date().toISOString(),
    matches,
    roles: ROLES,
    pointsPerLogit: round(pointsPerLogit, 3),
    center: round(mean, 5),
    shareFloor: SHARE_FLOOR,
    metrics: model.metrics,
    lambdas: model.lambdas,
    bias: round(model.bias, 5),
    off,
    champ,
    syn,
    vs,
    ts,
    tv,
    tags: tagOf,
  };
}

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

async function loadTags(client) {
  const rows = check(await client.from('champions').select('id,tags'));
  return new Map(rows.map((r) => [r.id, (r.tags && r.tags[0]) || 'None']));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Trains in a worker thread; resolves null if shouldStop() turned true and the training was stopped
function trainInWorker({ matches, share, tags, log, shouldStop, pollMs = BUSY_POLL_MS }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { matches, share: [...share], tags: [...tags] },
    });
    let stopped = false;
    const timer = setInterval(async () => {
      if (!stopped && (await shouldStop())) {
        stopped = true;
        worker.terminate();
      }
    }, pollMs);
    worker.on('message', (msg) => {
      if (msg.log) log(msg.log);
      if (msg.done) resolve(msg.done);
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      clearInterval(timer);
      if (stopped) resolve(null);
      else if (code !== 0) reject(new Error(`training stopped unexpectedly (exit code ${code})`));
    });
  });
}

/**
 * Trains on the stored matches of the patch and uploads the model, only while the
 * computer is free (no game, low GPU load). Waits up to waitMs for that; a training
 * that a game interrupts is dropped and tried again later.
 * Returns the metrics, or null if there was too little data or no free time.
 */
async function trainAndPublish({ client, patch, log, waitMs = 0 }) {
  const stored = loadMatches(patch);
  const matches = stored.length > MAX_TRAIN_MATCHES ? stored.slice(-MAX_TRAIN_MATCHES) : stored;
  if (matches.length < MIN_MATCHES) {
    log(`model: ${matches.length} single matches stored, ${MIN_MATCHES} needed to train`);
    return null;
  }

  const deadline = Date.now() + waitMs;
  for (let first = true; ; first = false) {
    const state = await idle.busyNow(log);
    if (!state.busy) break;
    if (Date.now() >= deadline) {
      log(`model: training postponed, ${idle.describe(state)}`);
      return null;
    }
    if (first) log(`model: waiting for a free computer (${idle.describe(state)})`);
    await sleep(IDLE_CHECK_MS);
  }

  const tags = await loadTags(client);
  const { share, games } = roleShares(matches);
  const t0 = Date.now();
  log(`model: training on ${matches.length} matches`);
  const model = await trainInWorker({
    matches,
    share,
    tags,
    log,
    shouldStop: async () => {
      const state = await idle.busyNow();
      if (state.busy) log(`model: training stopped, ${idle.describe(state)}; it runs again when the computer is free`);
      return state.busy;
    },
  });
  if (!model) return null;

  const m = model.metrics;
  log(
    `model: holdout accuracy ${(m.accuracy * 100).toFixed(2)}%, logloss ${m.logloss.toFixed(4)} ` +
      `(always-50% baseline ${m.baseLogloss.toFixed(4)}), ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  const data = exportModel(model, { share, games, tags, patch, matches: matches.length });
  check(
    await client.from('model_snapshots').insert({ source: 'riot-model', patch, matches: matches.length, metrics: m, data }).select('id'),
  );
  const ids = check(await client.from('model_snapshots').select('id').order('id', { ascending: false }));
  const old = ids.slice(KEEP_SNAPSHOTS).map((r) => r.id);
  if (old.length) check(await client.from('model_snapshots').delete().in('id', old));
  log(`model: uploaded (${data.syn.length} synergy and ${data.vs.length} matchup weights)`);
  return m;
}

module.exports = { storeMatches, loadMatches, trainAndPublish, trainInWorker, exportModel, POINTS_PER_LOGIT };
