const ROLES = ['top', 'jungle', 'middle', 'bottom', 'utility'];
const MIN_OBSERVATIONS = 500;
const MODEL_WEIGHTS = Array.from({ length: 11 }, (_, i) => i * 0.05);
const { matchLogit } = require('./predict');

const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const sigmoid = (value) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
const logLoss = (logit, win) => {
  const p = Math.max(1e-9, Math.min(1 - 1e-9, sigmoid(logit)));
  return -(win ? Math.log(p) : Math.log(1 - p));
};

function prepareMetaSource(snapshot) {
  const data = snapshot.data || snapshot;
  const meta = new Map();
  const byRole = new Map();
  for (const row of data.meta || []) {
    const role = ROLES.indexOf(row.role);
    if (role < 0 || !Number.isFinite(Number(row.score))) continue;
    const values = byRole.get(role) || [];
    values.push(Number(row.score));
    byRole.set(role, values);
    meta.set(`${row.champion_id}:${role}`, Number(row.score));
  }
  const stats = new Map([...byRole].map(([role, values]) => {
    const mean = average(values);
    const sd = Math.sqrt(average(values.map((value) => (value - mean) ** 2))) || 1;
    return [role, { mean, sd }];
  }));
  const synergy = new Map();
  for (const row of data.synergy || []) {
    const role = ROLES.indexOf(row.role);
    if (role < 0 || !Number.isFinite(Number(row.strength))) continue;
    const key = `${row.champion_id}:${role}:${row.ally_id}`;
    const values = synergy.get(key) || [];
    values.push(Number(row.strength));
    synergy.set(key, values);
  }
  const matchup = new Map();
  for (const row of data.matchup || []) {
    const role = ROLES.indexOf(row.role);
    const opponentRole = ROLES.indexOf(row.opponent_role || row.role);
    if (role < 0 || opponentRole < 0 || !Number.isFinite(Number(row.strength))) continue;
    matchup.set(`${row.champion_id}:${role}:${row.opponent_id}:${opponentRole}`, Number(row.strength));
  }
  const meanValue = (values) => values?.length ? average(values) : 0;
  return {
    strength(champion, role) {
      const score = meta.get(`${champion}:${role}`);
      const stat = stats.get(role);
      return score === undefined || !stat ? 0 : (score - stat.mean) / stat.sd;
    },
    synergy(a, ra, b, rb) {
      const direct = synergy.get(`${a}:${ra}:${b}`);
      const reverse = synergy.get(`${b}:${rb}:${a}`);
      if (direct?.length && reverse?.length) return (meanValue(direct) + meanValue(reverse)) / 2;
      return meanValue(direct?.length ? direct : reverse);
    },
    matchup(a, ra, b, rb) {
      const direct = matchup.get(`${a}:${ra}:${b}:${rb}`);
      if (direct !== undefined) return direct;
      const reverse = matchup.get(`${b}:${rb}:${a}:${ra}`);
      return reverse === undefined ? 0 : -reverse;
    },
  };
}

function metaFeatures(match, prepared) {
  let strength = 0;
  let synergy = 0;
  let matchup = 0;
  for (let role = 0; role < 5; role++) {
    strength += prepared.strength(match.b[role], role) - prepared.strength(match.r[role], role);
    for (let other = role + 1; other < 5; other++) {
      synergy += prepared.synergy(match.b[role], role, match.b[other], other);
      synergy -= prepared.synergy(match.r[role], role, match.r[other], other);
    }
    for (let enemyRole = 0; enemyRole < 5; enemyRole++) {
      matchup += prepared.matchup(match.b[role], role, match.r[enemyRole], enemyRole);
    }
  }
  return [strength, synergy, matchup];
}

function makeOutOfTimeObservations(matches, { modelSnapshot, sourceSnapshots, existingMatchIds = new Set(), now = Date.now() }) {
  if (!modelSnapshot?.data || !modelSnapshot.created_at) return [];
  const modelTime = Date.parse(modelSnapshot.created_at);
  if (!Number.isFinite(modelTime)) return [];
  const predict = matchLogit(modelSnapshot.data);
  const orderedSources = [...sourceSnapshots]
    .filter((snapshot) => snapshot.patch === modelSnapshot.patch && Number.isFinite(Date.parse(snapshot.collected_at)))
    .sort((a, b) => Date.parse(b.collected_at) - Date.parse(a.collected_at));
  const prepared = new Map(orderedSources.map((snapshot) => [snapshot.id, prepareMetaSource(snapshot)]));
  const out = [];
  for (const match of matches) {
    const startedAt = Number(match.t);
    if (!match.id || existingMatchIds.has(match.id) || !Number.isFinite(startedAt) || startedAt <= modelTime || startedAt > now) continue;
    if (match.patch !== modelSnapshot.patch || !Number.isFinite(match.w)) continue;
    const source = orderedSources.find((snapshot) => Date.parse(snapshot.collected_at) < startedAt);
    if (!source) continue;
    const modelLogit = predict(match);
    if (!Number.isFinite(modelLogit)) continue;
    const features = metaFeatures(match, prepared.get(source.id));
    out.push({
      match_id: match.id,
      patch: match.patch,
      started_at: new Date(startedAt).toISOString(),
      model_snapshot_id: modelSnapshot.id,
      source_snapshot_id: source.id,
      model_logit: modelLogit,
      meta_features: features,
      win: match.w === 1,
      startedAt,
      modelLogit,
      features,
    });
  }
  return out;
}

function fitMetaCalibrator(rows) {
  if (rows.length < 50) return null;
  const columns = [0, 1, 2].map((j) => rows.map((row) => Number(row.features[j]) || 0));
  const mean = columns.map(average);
  const sd = columns.map((values, j) => Math.sqrt(average(values.map((value) => (value - mean[j]) ** 2))) || 1);
  const weights = [0, 0, 0, 0];
  for (let iteration = 0; iteration < 500; iteration++) {
    const gradient = [0, 0, 0, 0];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const x = [1, ...columns.map((values, j) => (values[i] - mean[j]) / sd[j])];
      const error = sigmoid(weights[0] + x[1] * weights[1] + x[2] * weights[2] + x[3] * weights[3]) - (row.win ? 1 : 0);
      for (let j = 0; j < weights.length; j++) gradient[j] += error * x[j];
    }
    for (let j = 0; j < weights.length; j++) {
      const ridge = j === 0 ? 0 : 0.5 * weights[j];
      weights[j] -= 0.08 * (gradient[j] / rows.length + ridge / rows.length);
    }
  }
  return { mean, sd, weights };
}

function calibratedMetaLogit(features, calibration) {
  if (!calibration) return null;
  return calibration.weights[0] + features.reduce((sum, value, j) =>
    sum + calibration.weights[j + 1] * ((value - calibration.mean[j]) / calibration.sd[j]), 0);
}

function blendedLogit(modelLogit, metaLogit, modelWeight) {
  return modelWeight * modelLogit + (1 - modelWeight) * metaLogit;
}

function meanLoss(rows, calibration, modelWeight) {
  if (!rows.length || !calibration) return Infinity;
  return average(rows.map((row) => logLoss(
    blendedLogit(row.modelLogit, calibratedMetaLogit(row.features, calibration), modelWeight),
    row.win,
  )));
}

function lossImprovement(rows, calibration, candidateWeight, baselineWeight) {
  const differences = rows.map((row) => {
    const metaLogit = calibratedMetaLogit(row.features, calibration);
    return logLoss(blendedLogit(row.modelLogit, metaLogit, baselineWeight), row.win)
      - logLoss(blendedLogit(row.modelLogit, metaLogit, candidateWeight), row.win);
  });
  const improvement = average(differences);
  const sd = Math.sqrt(average(differences.map((value) => (value - improvement) ** 2)));
  return { improvement, se: sd / Math.sqrt(rows.length) };
}

function selectModelWeight(observations) {
  const rows = [...observations].sort((a, b) => a.startedAt - b.startedAt);
  if (rows.length < MIN_OBSERVATIONS) {
    return { supported: false, modelWeight: null, matches: rows.length, minimum: MIN_OBSERVATIONS };
  }
  const calibrationEnd = Math.floor(rows.length * 0.5);
  const tuneEnd = Math.floor(rows.length * 0.7);
  const calibrationRows = rows.slice(0, calibrationEnd);
  const tuneRows = rows.slice(calibrationEnd, tuneEnd);
  const validationRows = rows.slice(tuneEnd);
  const calibration = fitMetaCalibrator(calibrationRows);
  if (!calibration || !tuneRows.length || !validationRows.length) {
    return { supported: false, modelWeight: null, matches: rows.length, minimum: MIN_OBSERVATIONS };
  }

  const candidateWeight = MODEL_WEIGHTS.reduce((best, weight) =>
    meanLoss(tuneRows, calibration, weight) < meanLoss(tuneRows, calibration, best) ? weight : best, MODEL_WEIGHTS[0]);
  const validation = lossImprovement(validationRows, calibration, candidateWeight, 0.5);
  const supported = candidateWeight < 0.5 && validation.improvement > 2 * validation.se;
  return {
    supported,
    modelWeight: supported ? candidateWeight : 0.5,
    candidateWeight,
    matches: rows.length,
    calibrationMatches: calibrationRows.length,
    tuningMatches: tuneRows.length,
    validationMatches: validationRows.length,
    baselineLogloss: meanLoss(validationRows, calibration, 0.5),
    candidateLogloss: meanLoss(validationRows, calibration, candidateWeight),
    improvement: validation.improvement,
    se: validation.se,
  };
}

module.exports = {
  MIN_OBSERVATIONS,
  prepareMetaSource,
  metaFeatures,
  makeOutOfTimeObservations,
  fitMetaCalibrator,
  calibratedMetaLogit,
  blendedLogit,
  selectModelWeight,
};
