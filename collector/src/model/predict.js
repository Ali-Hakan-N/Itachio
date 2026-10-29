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
    return z;
  };
}

module.exports = { matchLogit };
