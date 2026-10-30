// Predicted log-odds that blue wins a compact match, from an exported model (the same
// terms the app adds up: strength, off-role, synergy, matchups, class pairs, latent pairs).
// Pure functions.

const { SHARE_FLOOR } = require('./features');
const { matchupOf } = require('./choice');

const dot = (a, b) => {
  if (!a || !b) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Returns (m) => log-odds that blue wins */
function matchLogit(data) {
  const matchup = matchupOf(data);
  const syn = new Map();
  for (const list of [data.syn, data.synE]) {
    for (const [a, ra, b, rb, w] of list || []) {
      for (const k of [`${a}:${ra}:${b}:${rb}`, `${b}:${rb}:${a}:${ra}`]) syn.set(k, (syn.get(k) || 0) + w);
    }
  }
  const ts = new Map();
  for (const [key, w] of Object.entries(data.ts || {})) {
    const [x, y] = key.split(':');
    ts.set(`${x}:${y}`, w);
    ts.set(`${y}:${x}`, w);
  }
  const tag = (c) => (data.tags || {})[c] || 'None';
  const floor = data.shareFloor || SHARE_FLOOR;
  const composition = data.comp;
  const styleOf = (team) => {
    const T = new Float64Array(composition?.k || 0);
    if (composition) for (const champion of team) {
      const u = composition.U[champion];
      if (u) for (let k = 0; k < T.length; k++) T[k] += u[k];
    }
    return T;
  };
  const compositionTerm = (blue, red) => {
    if (!composition) return 0;
    const B = styleOf(blue);
    const R = styleOf(red);
    const matrix = Array.from({ length: composition.k }, () => new Float64Array(composition.k));
    let m = 0;
    for (let i = 0; i < composition.k; i++) for (let j = i + 1; j < composition.k; j++) {
      matrix[i][j] = composition.m[m];
      matrix[j][i] = -composition.m[m++];
    }
    let z = 0;
    for (let i = 0; i < composition.k; i++) {
      z += composition.a[i] * (Math.tanh(B[i] + composition.c[i]) - Math.tanh(R[i] + composition.c[i]));
      for (let j = 0; j < composition.k; j++) z += B[i] * matrix[i][j] * R[j];
    }
    return z;
  };
  const pillarProfile = (team) => {
    let ap = 0, ad = 0, frontline = 0, control = 0, marksman = 0;
    for (const champion of team) {
      const type = tag(champion);
      if (type === 'Mage') ap += 1;
      if (type === 'Support') ap += 0.5;
      if (type === 'Marksman' || type === 'Assassin' || type === 'Fighter') ad += 1;
      if (type === 'Marksman') marksman += 1;
      if (type === 'Tank') frontline += 1;
      if (type === 'Fighter') frontline += 0.5;
      if (type === 'Tank' || type === 'Support') control += 1;
      if (type === 'Mage') control += 0.5;
    }
    const controlShare = control / 5;
    const damageLoad = (ap + ad) / 5;
    const frontlineShare = frontline / 5;
    return {
      damageImbalance: Math.abs(Math.log((ap + 0.5) / (ad + 0.5))),
      frontline: frontlineShare,
      control: controlShare,
      highDamageLowControl: damageLoad * (1 - controlShare),
      frontlineMarksman: frontlineShare * (marksman / 5),
    };
  };
  const pillarsTerm = (blue, red) => {
    const weights = data.pillars;
    if (!weights) return 0;
    const b = pillarProfile(blue);
    const r = pillarProfile(red);
    return (weights.damageImbalance || 0) * (b.damageImbalance - r.damageImbalance)
      + (weights.frontline || 0) * (b.frontline - r.frontline)
      + (weights.control || 0) * (b.control - r.control)
      + (weights.highDamageLowControl || 0) * (b.highDamageLowControl - r.highDamageLowControl)
      + (weights.frontlineMarksman || 0) * (b.frontlineMarksman - r.frontlineMarksman);
  };
  const strength = (c, r) => {
    const e = data.champ[`${c}:${r}`];
    return (e ? e[0] : 0) + (data.off?.[r] || 0) * -Math.log(Math.max(e ? e[2] : 0, floor));
  };
  const team = (t) => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      v += strength(t[i], i);
      for (let j = i + 1; j < 5; j++) {
        v += syn.get(`${t[i]}:${i}:${t[j]}:${j}`) || 0;
        v += ts.get(`${tag(t[i])}:${tag(t[j])}`) || 0;
        if (data.fm) v += dot(data.fm.S[`${t[i]}:${i}`], data.fm.S[`${t[j]}:${j}`]);
      }
    }
    return v;
  };
  return (m) => {
    let z = (data.bias || 0) + team(m.b) - team(m.r);
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) z += matchup(m.b[i], i, m.r[j], j);
    return z + compositionTerm(m.b, m.r) + pillarsTerm(m.b, m.r);
  };
}

module.exports = { matchLogit };
