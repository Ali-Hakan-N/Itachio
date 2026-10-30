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
const { counterpickTendency } = require('./choice');
const { exportComp } = require('./comp');
const { analyzeBuilds, analyzeSituations, loadDdragon } = require('./builds');
const { makeOutOfTimeObservations, selectModelWeight } = require('./ensemble');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'matches');
const SCORE_SD = 15;
const POINTS_PER_LOGIT = 75; // fallback when there is too little data to measure the spread
const SCALE_MIN_GAMES = 100;
// Typical spread of champion strength in high elo is a few win-rate points, about
// 0.08 in logit. With little data the model shrinks strengths far below that; the
// scale is then not stretched past this, so scores stay near 50 instead of turning
// noise into big numbers. They spread out as data comes in.
const MIN_SPREAD = 0.08;
const FM_MIN_GAMES = 20;
const REPORT_FILE = path.join(DATA_DIR, '..', 'model-report.json');
const PRUNE = 0.002; // pair weights smaller than this are left out of the upload
const MIN_MATCHES = 2000;
const MAX_TRAIN_MATCHES_HARD = 1_000_000;
const DEFAULT_TRAIN_MATCHES = 300_000;
function resolveTrainMatchLimit(value = process.env.MODEL_MAX_TRAIN_MATCHES) {
  const requested = Number.parseInt(value || '', 10);
  return Number.isFinite(requested)
    ? Math.min(MAX_TRAIN_MATCHES_HARD, Math.max(MIN_MATCHES, requested))
    : DEFAULT_TRAIN_MATCHES;
}
const MAX_TRAIN_MATCHES = resolveTrainMatchLimit();
const KEEP_SNAPSHOTS = 3;
const ENSEMBLE_OBSERVATION_LIMIT = 5000;
const ENSEMBLE_OBSERVATION_DAYS = 180;
const BAN_MIN_MATCHES = 500; // ban rates are exported from this many matches with bans
const IDLE_CHECK_MS = 60_000; // while waiting for a free computer
const BUSY_POLL_MS = 20_000; // while training: stop if a game starts

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const fileFor = (patch) => path.join(DATA_DIR, `${patch.replace(/[^0-9.]/g, '')}.jsonl`);
// Starting items read later from timelines (riot/timelines.js): { id, sb, sr } per line
const startsFor = (patch) => path.join(DATA_DIR, `${patch.replace(/[^0-9.]/g, '')}.starts`);

/** Adds starting items of stored matches: rows [{ id, sb, sr }] */
function storeStarts(patch, rows) {
  if (!rows.length) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(startsFor(patch), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

function loadStarts(patch) {
  const out = new Map();
  if (!fs.existsSync(startsFor(patch))) return out;
  for (const line of fs.readFileSync(startsFor(patch), 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      out.set(r.id, r);
    } catch {
      /* a line cut off by a crash */
    }
  }
  return out;
}

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
  const starts = loadStarts(patch);
  const seen = new Set();
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const st = starts.get(m.id);
      if (st && !m.sb) Object.assign(m, { sb: st.sb, sr: st.sr });
      out.push(m);
    } catch {
      /* a line cut off by a crash: skip it */
    }
  }
  return out;
}

/**
 * The model as the app reads it. Roles are indexes into ROLES.
 *   champ: { "<champ>:<role>": [weight, games, share, standard error] }
 *   off:   weight per role for -ln(share)
 *   syn:   [[a, ra, b, rb, weight, se]]   same team, a:ra before b:rb
 *   vs:    [[a, ra, b, rb, weight, se]]   a against b; b against a is -weight
 *   ts/tv: { "<classA>:<classB>": weight }   classes sorted; tv is classA against classB
 *   fm:    { k, S, P, Q: { "<champ>:<role>": vector } } latent pairs, when that layer was kept:
 *          synergy <S_a, S_b>, a against b <P_a, Q_b> - <P_b, Q_a>
 *   synE/vsE: [[a, ra, b, rb, weight]] pairs through the early game layer (model/early.js),
 *          when it was kept: added to syn/vs (same sign rules)
 *   early: { matches, kept, accuracy of the early state alone, kappa, beta, laneMean, laneVs, objMean } or null. When kept,
 *          champion strength through the early game is already included in champ and off
 *   banRate: { "<champ>": share of matches it was banned in } (when enough matches have bans)
 *   counterpick: { lambda, se, picks } how much players pick against their opponents (choice.js)
 *   comp:  { k, U: { "<champ>": [k style numbers] }, a, c, m } team composition (comp.js)
 * Layers the training left out are absent (no pair weights, no fm).
 */
/** Share of matches each champion was banned in, from matches that record bans */
function banRates(matches) {
  const withBans = matches.filter((m) => Array.isArray(m.x));
  if (withBans.length < BAN_MIN_MATCHES) return null;
  const count = new Map();
  for (const m of withBans) for (const c of new Set(m.x)) count.set(c, (count.get(c) || 0) + 1);
  return Object.fromEntries([...count].map(([c, n]) => [c, round(n / withBans.length, 4)]));
}

function exportModel(model, { share, games, tags, patch, matches, banRate = null }) {
  const champ = {};
  const off = new Array(5).fill(0);
  const syn = [];
  const vs = [];
  const ts = {};
  const tv = {};
  const pillars = { damageImbalance: 0, frontline: 0, control: 0, highDamageLowControl: 0, frontlineMarksman: 0 };
  const se = (i) => (model.se ? round(model.se[i], 5) : null);
  const on = new Set(model.groups || ['c', 'o', 's', 'ts', 'v', 'tv']);
  model.keys.forEach((key, i) => {
    const w = round(model.w[i], 5);
    const p = key.split(':');
    if (!on.has(p[0])) return;
    if (p[0] === 'c') champ[`${p[1]}:${p[2]}`] = [w, games.get(`${p[1]}:${p[2]}`) || 0, round(share.get(`${p[1]}:${p[2]}`) || 0, 4), se(i)];
    else if (p[0] === 'o') off[Number(p[1])] = w;
    else if (p[0] === 's' && Math.abs(w) >= PRUNE) syn.push([+p[1], +p[2], +p[3], +p[4], w, se(i)]);
    else if (p[0] === 'v' && Math.abs(w) >= PRUNE) vs.push([+p[1], +p[2], +p[3], +p[4], w, se(i)]);
    else if (p[0] === 'ts') ts[`${p[1]}:${p[2]}`] = w;
    else if (p[0] === 'tv') tv[`${p[1]}:${p[2]}`] = w;
    else if (p[0] === 'a' && p[1] in pillars) pillars[p[1]] = w;
  });

  // Latent vectors of champion:role pairs with enough games (others are near zero anyway)
  let fm = null;
  if (model.fm) {
    fm = { k: model.fm.k, S: {}, P: {}, Q: {} };
    const k = model.fm.k;
    model.fm.entities.forEach((key, e) => {
      if ((games.get(key) || 0) < FM_MIN_GAMES) return;
      for (const name of ['S', 'P', 'Q']) fm[name][key] = Array.from(model.fm[name].subarray(e * k, e * k + k), (v) => round(v, 4));
    });
  }
  const throughEarly = (list) =>
    (list || [])
      .filter(([, w]) => Math.abs(w) >= PRUNE)
      .map(([key, w]) => [...key.split(':').slice(1).map(Number), round(w, 5)]);
  const synE = throughEarly(model.early?.pairs.s);
  const vsE = throughEarly(model.early?.pairs.v);
  const early = model.early
    ? {
        matches: model.early.matches,
        kept: model.early.kept,
        accuracy: round(model.early.surrogate.accuracy, 4),
        // For player analysis: how the early state is priced, and each champion's average lane
        beta: model.early.surrogate.beta.map((b) => round(b, 5)),
        laneMean: Object.fromEntries(Object.entries(model.early.laneMean || {}).map(([k, v]) => [k, round(v, 4)])),
        // For the game plan: lane matchups [role, a, b, value from a's side, games], and
        // each champion:role's part of its side's first objectives
        laneVs: (model.early.laneVs || []).map(([k, a, b, v, n]) => [k, a, b, round(v, 4), n]),
        objMean: Object.fromEntries(Object.entries(model.early.objMean || {}).map(([k, v]) => [k, round(v, 4)])),
        kappa: model.early.kappa ? Object.fromEntries(Object.entries(model.early.kappa).map(([p, k]) => [p, round(k, 4)])) : null,
      }
    : null;
  // Strength through the early game goes into the champion's own strength and the
  // off-role term (which stays non-positive), so everything reading champ is consistent
  for (const [key, w] of model.early?.pairs.c || []) {
    const p = key.split(':');
    if (p[0] === 'c' && champ[`${p[1]}:${p[2]}`]) champ[`${p[1]}:${p[2]}`][0] = round(champ[`${p[1]}:${p[2]}`][0] + w, 5);
    else if (p[0] === 'o') off[Number(p[1])] = round(Math.min(0, off[Number(p[1])] + w), 5);
  }

  // Scale: spread of champion strength (with the off-role term) among well-played picks
  const bases = [];
  for (const [key, [w, n, s]] of Object.entries(champ)) {
    if (n < SCALE_MIN_GAMES) continue;
    bases.push(w + off[Number(key.split(':')[1])] * -Math.log(Math.max(s, SHARE_FLOOR)));
  }
  const mean = bases.length ? bases.reduce((a, b) => a + b, 0) / bases.length : 0;
  const sd = bases.length > 1 ? Math.sqrt(bases.reduce((a, b) => a + (b - mean) ** 2, 0) / bases.length) : 0;
  const pointsPerLogit = SCORE_SD / Math.max(sd, MIN_SPREAD);

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
    synE,
    vsE,
    early,
    banRate,
    comp: model.composition ? exportComp(model.composition).comp : null,
    ts,
    tv,
    fm,
    pillars,
    tags: tagOf,
  };
}

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

async function loadNewestModelSnapshot(client) {
  return check(await client.from('model_snapshots').select('id,patch,created_at,data')
    .eq('source', 'riot-model').order('created_at', { ascending: false }).limit(1).maybeSingle());
}

async function loadMetaSourceSnapshots(client, log) {
  try {
    return check(await client.from('meta_source_snapshots').select('id,patch,collected_at,data')
      .eq('source', 'metasrc').order('collected_at', { ascending: false }).limit(180));
  } catch (err) {
    log(`model: MetaSrc snapshots unavailable (${err.message}); keeping confidence-based ensemble`);
    return [];
  }
}

async function loadEnsembleObservations(client, log) {
  try {
    const rows = [];
    for (let from = 0; from < ENSEMBLE_OBSERVATION_LIMIT; from += 1000) {
      const page = check(await client.from('ensemble_observations')
        .select('match_id,started_at,model_logit,meta_features,win')
        .order('started_at', { ascending: false }).range(from, from + 999));
      rows.push(...page);
      if (page.length < 1000) break;
    }
    return rows.map((row) => ({
      matchId: row.match_id,
      startedAt: Date.parse(row.started_at),
      modelLogit: Number(row.model_logit),
      features: row.meta_features,
      win: row.win,
    })).filter((row) => Number.isFinite(row.startedAt) && Number.isFinite(row.modelLogit) && Array.isArray(row.features));
  } catch (err) {
    log(`model: ensemble observations unavailable (${err.message}); keeping confidence-based ensemble`);
    return [];
  }
}

async function writeEnsembleObservations(client, rows, log) {
  if (!rows.length) return false;
  try {
    for (let i = 0; i < rows.length; i += 500) {
      check(await client.from('ensemble_observations').upsert(rows.slice(i, i + 500).map(({ startedAt, modelLogit, features, ...row }) => row), {
        onConflict: 'match_id', ignoreDuplicates: true,
      }));
    }
    const cutoff = new Date(Date.now() - ENSEMBLE_OBSERVATION_DAYS * 86400000).toISOString();
    check(await client.from('ensemble_observations').delete().lt('started_at', cutoff));
    log(`model: saved ${rows.length} out-of-time ensemble observations`);
    return true;
  } catch (err) {
    log(`model: ensemble observations not saved (${err.message}); keeping confidence-based ensemble`);
    return false;
  }
}

async function loadNames(client) {
  const rows = check(await client.from('champions').select('id,name'));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Human-readable training report: log lines and data/model-report.json */
function writeReport({ data, metrics: m, champions, seconds, ensemble, log }) {
  const scoreOf = (w, role, share) =>
    50 + 50 * Math.tanh((data.pointsPerLogit * (w + data.off[role] * -Math.log(Math.max(share, SHARE_FLOOR)) - data.center)) / 50);
  const top = {};
  ROLES.forEach((role, r) => {
    top[role] = Object.entries(data.champ)
      .filter(([key, [, games]]) => Number(key.split(':')[1]) === r && games >= SCALE_MIN_GAMES)
      .map(([key, [w, games, share, se]]) => ({
        champion: champions.get(Number(key.split(':')[0])) || key,
        score: Math.round(scoreOf(w, r, share)),
        plusMinus: se ? Math.round(se * data.pointsPerLogit) : null,
        games,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  });
  // Strongest early game pairs, readable: "Ahri middle + Vi jungle", "Lissandra middle vs Zed middle"
  // (a positive matchup weight favors the first champion)
  const pairs = (list, sep) =>
    [...(list || [])]
      .sort((x, y) => Math.abs(y[4]) - Math.abs(x[4]))
      .slice(0, 15)
      .map(([a, ra, b, rb, w, se, games]) => ({
        pair: `${champions.get(a) || a} ${ROLES[ra]}${sep}${champions.get(b) || b} ${ROLES[rb]}`,
        weight: w,
        se,
        games,
      }));
  const report = {
    trainedAt: data.trainedAt,
    patch: data.patch,
    matches: m.matches,
    seconds,
    accuracy: `${(m.accuracy * 100).toFixed(2)}% ± ${(m.accuracyCI * 100).toFixed(2)}`,
    logloss: m.logloss,
    alwaysFiftyLogloss: m.baseLogloss,
    layers: m.layers.map((l) => ({ name: l.name, kept: l.accepted, proven: l.proven ?? true, gain: l.improvement, se: l.se })),
    calibration: m.calibration,
    ensemble,
    pointsPerLogit: data.pointsPerLogit,
    weights: { synergy: data.syn.length, matchup: data.vs.length, latent: data.fm ? Object.keys(data.fm.S).length : 0 },
    topByRole: top,
    // The champions highest and lowest on every learned style
    styles: data.comp
      ? Array.from({ length: data.comp.k }, (_, k) => {
          const ranked = Object.entries(data.comp.U).sort((x, y) => y[1][k] - x[1][k]).map(([c]) => champions.get(Number(c)) || c);
          return { weight: data.comp.a[k], high: ranked.slice(0, 8), low: ranked.slice(-8) };
        })
      : null,
    early: data.early && {
      ...data.early,
      synergy: pairs(data.synE, ' + '),
      matchup: pairs(data.vsE, ' vs '),
    },
  };
  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  } catch {
    /* the report is optional */
  }
  log(`model: ${m.matches} matches, ${seconds}s · proven: ${m.layers.filter((l) => l.proven ?? true).map((l) => l.name).join(', ')}`);
  if (ensemble?.supported) {
    log(`model: ensemble ${Math.round(ensemble.modelWeight * 100)}% model / ${Math.round((1 - ensemble.modelWeight) * 100)}% MetaSrc · ${ensemble.validationMatches} validation matches, logloss ${ensemble.candidateLogloss.toFixed(5)} vs ${ensemble.baselineLogloss.toFixed(5)}`);
  } else {
    log(`model: ensemble not tuned (${ensemble?.matches || 0}/${ensemble?.minimum || 500} out-of-time matches); confidence weighting remains active`);
  }
  for (const role of ROLES) log(`model: top ${role.padEnd(7)} ${top[role].map((t) => `${t.champion} ${t.score}`).join(', ') || '(not enough games yet)'}`);
}

async function loadTags(client) {
  const rows = check(await client.from('champions').select('id,tags'));
  return new Map(rows.map((r) => [r.id, (r.tags && r.tags[0]) || 'None']));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Trains in a worker thread; resolves null if shouldStop() turned true and the training was stopped
function trainInWorker({ matches, share, tags, log, shouldStop, pollMs = BUSY_POLL_MS, options = {} }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { matches, share: [...share], tags: [...tags], options },
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

// Patch strings ("16.21") compared as versions
const patchOrder = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

// How many matches the model needs: the smallest training set in which every layer in
// PROVEN_LAYERS was proven, measured by the trainings themselves (state file); until one
// is seen, DEFAULT_ENOUGH. Older patches only fill the current patch up to this.
const STATE_FILE = path.join(DATA_DIR, '..', 'model-state.json');
const PROVEN_LAYERS = ['strength', 'early game', 'synergy', 'matchup'];
const DEFAULT_ENOUGH = 60000;
const MIN_ENOUGH = 20000;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Matches needed for a proven model (see above) */
function enoughMatches() {
  const n = readState().provenAt;
  return Number.isFinite(n) ? Math.min(MAX_TRAIN_MATCHES, Math.max(MIN_ENOUGH, n)) : DEFAULT_ENOUGH;
}

/** After a training: if every required layer was proven, remember the smallest such size */
function recordProven(metrics) {
  const proven = new Map(metrics.layers.map((l) => [l.name, l.proven ?? true]));
  if (!PROVEN_LAYERS.every((name) => proven.get(name))) return null;
  const state = readState();
  if (Number.isFinite(state.provenAt) && state.provenAt <= metrics.matches) return state.provenAt;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, provenAt: metrics.matches }, null, 2));
  } catch {
    /* the state is optional */
  }
  return metrics.matches;
}

/**
 * Which matches to train on. current: the current patch's matches; older: older patches'
 * lists, newest patch first. All of the current patch (its newest max), and only while it
 * has fewer than enough, the newest matches of the older patches fill it up to enough.
 * Pure. Returns [{ patch, matches }] in training order (oldest first).
 */
function pickTraining(current, older, { enough, max }) {
  const own = current.matches.length > max ? current.matches.slice(-max) : current.matches;
  let room = Math.max(0, Math.min(enough, max) - own.length);
  const parts = [{ patch: current.patch, matches: own }];
  for (const o of older) {
    if (room <= 0) break;
    const take = o.matches.length > room ? o.matches.slice(-room) : o.matches;
    if (!take.length) continue;
    parts.unshift({ patch: o.patch, matches: take });
    room -= take.length;
  }
  return parts.filter((p) => p.matches.length);
}

/**
 * Training set: the current patch, filled from older patches only until it has enough
 * matches for a proven model (pickTraining). Returns { matches, byPatch }.
 */
function loadTrainingMatches(patch, { enough = enoughMatches() } = {}) {
  const current = patch.replace(/[^0-9.]/g, '');
  const patches = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6))
    : [];
  const older = patches.filter((p) => patchOrder(p, current) < 0).sort((a, b) => patchOrder(b, a));
  const own = loadMatches(current);
  // Older patches are only read when they are needed
  const parts = pickTraining({ patch: current, matches: own }, own.length >= enough ? [] : older.map((p) => ({ patch: p, matches: loadMatches(p) })), {
    enough,
    max: MAX_TRAIN_MATCHES,
  });
  return { matches: parts.flatMap((p) => p.matches), byPatch: Object.fromEntries(parts.map((p) => [p.patch, p.matches.length])) };
}

/**
 * Trains on the stored matches (loadTrainingMatches) and uploads the model, only while the
 * computer is free (no game, low GPU load). Waits up to waitMs for that; a training
 * that a game interrupts is dropped and tried again later. ignoreBusy trains right
 * away regardless (manual runs).
 * Returns the metrics, or null if there was too little data or no free time.
 */
async function trainAndPublish({ client, patch, log, waitMs = 0, ignoreBusy = false }) {
  const { matches, byPatch } = loadTrainingMatches(patch);
  if (matches.length < MIN_MATCHES) {
    log(`model: ${matches.length} single matches stored, ${MIN_MATCHES} needed to train`);
    return null;
  }

  const deadline = Date.now() + waitMs;
  for (let first = true; !ignoreBusy; first = false) {
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
  log(`model: training on ${matches.length} matches (${Object.entries(byPatch).map(([p, n]) => `${p}: ${n}`).join(', ')})`);
  const model = await trainInWorker({
    matches,
    share,
    tags,
    log,
    shouldStop: async () => {
      if (ignoreBusy) return false;
      const state = await idle.busyNow();
      if (state.busy) log(`model: training stopped, ${idle.describe(state)}; it runs again when the computer is free`);
      return state.busy;
    },
  });
  if (!model) return null;

  const m = model.metrics;
  const provenAt = recordProven(m);
  if (provenAt) log(`model: every layer proven; ${provenAt} matches are enough, older patches fill up to that`);
  const [previousSnapshot, sourceSnapshots, previousObservations] = await Promise.all([
    loadNewestModelSnapshot(client).catch((err) => (log(`model: previous snapshot unavailable (${err.message})`), null)),
    loadMetaSourceSnapshots(client, log),
    loadEnsembleObservations(client, log),
  ]);
  const existingMatchIds = new Set(previousObservations.map((row) => row.matchId));
  const newObservations = makeOutOfTimeObservations(matches, {
    modelSnapshot: previousSnapshot,
    sourceSnapshots,
    existingMatchIds,
  });
  const observationsSaved = await writeEnsembleObservations(client, newObservations, log);
  const ensembleHistory = [...previousObservations, ...(observationsSaved ? newObservations : [])]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-ENSEMBLE_OBSERVATION_LIMIT);
  const ensemble = selectModelWeight(ensembleHistory);
  const data = exportModel(model, { share, games, tags, patch, matches: matches.length, banRate: banRates(matches) });
  data.ensemble = ensemble;
  data.counterpick = counterpickTendency(data, matches);
  if (data.counterpick) {
    const c = data.counterpick;
    log(`model: counterpicks  λ = ${c.lambda.toFixed(2)} ± ${(c.se ?? 0).toFixed(2)} over ${c.picks} picks (0 = picks follow popularity only)`);
  }
  writeReport({ data, metrics: m, champions: await loadNames(client), seconds: Math.round((Date.now() - t0) / 1000), ensemble, log });
  check(
    await client.from('model_snapshots').insert({ source: 'riot-model', patch, matches: matches.length, metrics: m, data }).select('id'),
  );
  const ids = check(await client.from('model_snapshots').select('id').order('id', { ascending: false }));
  const old = ids.slice(KEEP_SNAPSHOTS).map((r) => r.id);
  if (old.length) check(await client.from('model_snapshots').delete().in('id', old));
  await publishBuilds(client, matches, patch, log).catch((err) => log(`builds: failed (${err.message})`));
  log(`model: uploaded (${data.syn.length} synergy and ${data.vs.length} matchup weights, early game ${data.synE.length} + ${data.vsE.length})`);
  return m;
}

/**
 * Runes, items and spells per champion and role (builds.js) to champion_builds, and the
 * champions' magic share with the damage thresholds to app_meta 'champion_damage', so the
 * app can tell which build fits the enemy team, and the situational items (what each item
 * is worth against each enemy champion) to app_meta 'item_situations'.
 */
async function publishBuilds(client, matches, patch, log) {
  const meta = check(await client.from('app_meta').select('value').eq('key', 'current_patch').maybeSingle());
  const facts = await loadDdragon(meta?.value || `${patch}.1`);
  const { rows, thresholds } = analyzeBuilds(matches, facts);
  if (!rows.length) return log('builds: no games with runes and items yet');
  check(await client.from('champion_builds').delete().neq('bucket', ''));
  const stamp = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 500) {
    check(await client.from('champion_builds').insert(rows.slice(i, i + 500).map((r) => ({ ...r, patch, updated_at: stamp }))));
  }
  const damage = { magic: Object.fromEntries(Object.entries(facts.magic).map(([c, v]) => [c, round(v, 3)])), thresholds: thresholds.map((t) => round(t, 3)) };
  check(await client.from('app_meta').upsert({ key: 'champion_damage', value: JSON.stringify(damage), updated_at: stamp }));
  const situations = analyzeSituations(matches, facts);
  check(await client.from('app_meta').upsert({ key: 'item_situations', value: JSON.stringify(situations), updated_at: stamp }));
  const general = rows.filter((r) => r.bucket === 'any').length;
  const learned = situations.features.map((f, j) => `${f} ${Object.values(situations.items).filter((w) => w[j]).length}`).join(', ');
  log(`builds: ${general} champion builds, ${rows.length - general} against one kind of damage, ${rows.filter((r) => r.items.start).length} with starting items · situational items: ${Object.keys(situations.items).length} items (by part: ${learned})`);
}

module.exports = { banRates, publishBuilds, pickTraining, storeMatches, storeStarts, loadMatches, loadTrainingMatches, trainAndPublish, trainInWorker, exportModel, POINTS_PER_LOGIT, MAX_TRAIN_MATCHES, resolveTrainMatchLimit };
