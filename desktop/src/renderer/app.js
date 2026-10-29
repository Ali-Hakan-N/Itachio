/* global api, Engine */
// UI. State comes from the main process (api.onState); this file only renders and sends requests.

const ROLES = [
  ['top', 'Top'],
  ['jungle', 'Jungle'],
  ['middle', 'Mid'],
  ['bottom', 'Bot'],
  ['utility', 'Support'],
];
const ROLE_NAME = Object.fromEntries(ROLES);

const PHASE_TEXT = {
  None: 'Idle',
  Lobby: 'In lobby',
  Matchmaking: 'In queue',
  ReadyCheck: 'Match found',
  ChampSelect: 'Champ select',
  GameStart: 'Loading game',
  InProgress: 'In game',
  WaitingForStats: 'Waiting for stats',
  PreEndOfGame: 'Game over',
  EndOfGame: 'Post game',
};

let S = null; // state from the main process
let tab = 'draft';
let screen = 'loading'; // loading | config | login | profile | team | main
let configError = null;
// Whose champion statistics are shown (default: me), and from which games
const statsUi = { player: null, source: 'history' };
const STAT_SOURCES = [
  ['history', 'This patch'], // the player's Solo/Duo and Flex games of the patch
  ['team', 'With the team'], // the Flex games the whole team played together
];

const $view = document.getElementById('view');
const $status = document.getElementById('status');
const $tabs = document.getElementById('tabs');

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function champMap() {
  if (!S) return new Map();
  if (S._champMap?.src !== S.champions) {
    S._champMap = { src: S.champions, map: new Map(S.champions.map((c) => [c.id, c])) };
  }
  return S._champMap.map;
}

function champImg(id, size = '') {
  const c = champMap().get(id);
  if (!id || !c) return `<span class="champ ${size} empty"></span>`;
  const src = S.patch ? `https://ddragon.leagueoflegends.com/cdn/${S.patch}/img/champion/${c.image}` : '';
  return src
    ? `<span class="champ ${size}" title="${esc(c.name)}"><img src="${src}" alt="${esc(c.name)}" loading="lazy"></span>`
    : `<span class="champ ${size}" title="${esc(c.name)}">${esc(c.name.slice(0, 2))}</span>`;
}
const champName = (id) => champMap().get(id)?.name || '';

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}

async function run(promise) {
  const res = await promise;
  if (!res.ok) {
    toast(res.error, 'error');
    throw new Error(res.error);
  }
  return res.data;
}

function myPool() {
  return S.me ? S.pools.filter((p) => p.player_id === S.me.id) : [];
}

// ---------- flow ----------
// ---------- Updates ----------
let updateState = { state: 'idle' };

// Updates download quietly; once one is ready a blinking Update button shows in the top
// bar. Clicking it restarts into the new version (full-screen while installing).
function renderUpdate() {
  const box = document.getElementById('update');
  const btn = document.getElementById('upbtn');
  const u = updateState;
  const bar = (cls) => `<div class="progress ${cls}"><div data-w="${u.percent || 0}"></div></div>`;

  btn.hidden = u.state !== 'ready';
  btn.title = u.version ? `Version ${u.version} is ready. Click to restart and update.` : 'Click to restart and update.';
  btn.onclick = () => api.installUpdate();

  if (u.state === 'installing') {
    box.innerHTML = `
      <div class="update-overlay">
        <div class="update-card">
          <span class="logo big" aria-hidden="true"></span>
          <h2>Installing update</h2>
          <p>The app restarts in a moment.</p>
          ${bar('')}
        </div>
      </div>`;
  } else {
    box.innerHTML = '';
  }
  for (const el of box.querySelectorAll('[data-w]')) el.style.width = `${el.dataset.w}%`;
}
api.onUpdate((u) => {
  updateState = u;
  renderUpdate();
});

async function boot() {
  const init = await run(api.init());
  appVersion = init.version || '';
  renderVersion();
  api.getUpdate().then((res) => {
    if (res.ok && res.data) {
      updateState = res.data;
      renderUpdate();
    }
  });
  if (init.configError) {
    configError = init.configError;
    screen = 'config';
    return render();
  }
  if (!init.user) {
    screen = 'login';
    return render();
  }
  await loadAll();
}

async function loadAll() {
  screen = 'loading';
  render();
  try {
    S = await run(api.loadData());
  } catch {
    screen = 'login';
    return render();
  }
  decideScreen();
}

function decideScreen() {
  if (!S.me) screen = 'profile';
  else if (!S.me.team_id) screen = 'team';
  else screen = 'main';
  render();
}

let appVersion = '';
function renderVersion() {
  document.getElementById('ver').textContent = appVersion ? `v${appVersion}` : '';
}

api.onState((partial) => {
  if (!S) S = {};
  Object.assign(S, partial);
  if (screen === 'main' && 'me' in partial && !partial.me?.team_id) return decideScreen();
  renderStatus();
  // Keep focus while typing on the pool screen: re-render only the affected parts
  if (screen !== 'main') return;
  if (tab === 'draft' && ('draft' in partial || 'pools' in partial || 'lcu' in partial || 'members' in partial || 'model' in partial)) renderMain();
  if (tab === 'team' && ('members' in partial || 'pools' in partial || 'team' in partial)) renderMain();
  if (tab === 'champions' && ('playerStats' in partial || 'members' in partial || 'model' in partial)) renderMain();
});
api.onSaved((info) => {
  if (info.type === 'match') toast('Match result and draft saved');
});

$tabs.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b || b.disabled) return;
  tab = b.dataset.tab;
  for (const x of $tabs.querySelectorAll('button')) x.classList.toggle('active', x === b);
  renderMain();
});

// ---------- rendering ----------
function render() {
  $tabs.hidden = screen !== 'main';
  renderStatus();
  if (screen === 'loading') $view.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;
  if (screen === 'config') renderConfig();
  if (screen === 'login') renderLogin();
  if (screen === 'profile') renderProfile();
  if (screen === 'team') renderTeamSetup();
  if (screen === 'main') renderMain();
}

function renderStatus() {
  const l = S?.lcu;
  if (!l) return ($status.innerHTML = '');
  const acct = l.summoner?.riotId ? ` · ${esc(l.summoner.riotId)}` : '';
  $status.innerHTML = l.connected
    ? `<span class="dot on"></span><span>${esc(PHASE_TEXT[l.phase] || l.phase)}${acct}</span>`
    : `<span class="dot"></span><span>Waiting for the League client</span>`;
}

function renderConfig() {
  $view.innerHTML = `
    <div class="card">
      <h2>Setup incomplete</h2>
      <p>${esc(configError)}</p>
      <p>Copy <b>config.example.json</b> in the app folder to <b>config.json</b>,
      fill in your Supabase project URL and key, then restart the app.</p>
    </div>`;
}

function renderLogin(mode = 'signin') {
  const signup = mode === 'signup';
  $view.innerHTML = `
    <form class="card" id="f">
      <h2>${signup ? 'Create account' : 'Sign in'}</h2>
      <label>Email <input name="email" type="email" required autocomplete="email"></label>
      <label>Password <input name="password" type="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
      <div class="err" id="err"></div>
      <button class="btn primary" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
      <button class="link" type="button" id="swap">${signup ? 'Have an account? Sign in' : 'No account? Create one'}</button>
    </form>`;
  document.getElementById('swap').onclick = () => renderLogin(signup ? 'signin' : 'signup');
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    const res = await (signup ? api.signUp(fd) : api.signIn(fd));
    btn.disabled = false;
    if (!res.ok) return (document.getElementById('err').textContent = res.error);
    if (signup && res.data?.needsConfirmation) {
      renderLogin('signin');
      return toast('Click the confirmation link in your email, then sign in');
    }
    await loadAll();
  };
}

function renderProfile() {
  const me = S?.me;
  $view.innerHTML = `
    <form class="card" id="f">
      <h2>Player profile</h2>
      <p>Your teammates will see you by this name. Your LoL account links automatically while the client is open.</p>
      <label>Nickname <input name="nickname" required minlength="2" maxlength="32" value="${esc(me?.nickname || S?.lcu?.summoner?.riotId?.split('#')[0] || '')}"></label>
      <button class="btn primary" type="submit">Save profile</button>
      ${me ? '' : '<button class="link" type="button" id="out">Sign out</button>'}
    </form>`;
  // Editing an existing profile: sign out lives in the Team tab
  if (!me) document.getElementById('out').onclick = signOut;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    S = await run(api.saveProfile(Object.fromEntries(new FormData(e.target))));
    decideScreen();
  };
}

function renderTeamSetup() {
  $view.innerHTML = `
    <div class="card">
      <h2>Join your team</h2>
      <p>Enter the 8-character code from a teammate.</p>
      <form class="row" id="join"><input name="code" placeholder="Team code" required class="grow upper"><button class="btn primary">Join</button></form>
      <p class="gap">First one on the team? Create it and share the code with your friends.</p>
      <form class="row" id="create"><input name="name" placeholder="Team name" required minlength="2" class="grow"><button class="btn">Create team</button></form>
      <button class="link" type="button" id="out">Sign out</button>
    </div>`;
  document.getElementById('out').onclick = signOut;
  document.getElementById('join').onsubmit = async (e) => {
    e.preventDefault();
    S = await run(api.joinTeam(new FormData(e.target).get('code')));
    decideScreen();
  };
  document.getElementById('create').onsubmit = async (e) => {
    e.preventDefault();
    S = await run(api.createTeam(new FormData(e.target).get('name')));
    decideScreen();
  };
}

async function signOut() {
  await run(api.signOut());
  S = { ...S, me: null };
  screen = 'login';
  render();
}

function renderMain() {
  if (tab === 'draft') renderDraft();
  if (tab === 'champions') renderChampions();
  if (tab === 'team') renderTeam();
  if (tab === 'history') renderHistory();
}

// ---------- Draft ----------
let timerHandle = null;

function memberByPuuid(puuid) {
  return puuid ? S.members.find((m) => m.puuid === puuid) : null;
}

function unavailable(d) {
  const ids = new Set([...d.allyBans, ...d.enemyBans]);
  for (const p of [...d.ally, ...d.enemy]) if (p.locked && p.championId) ids.add(p.championId);
  return ids;
}

// Champion shown in a slot: the locked pick, or the hover on our side
// (the client hides enemy hovers until they lock)
const shownChamp = (p) => (p.locked ? p.championId : p.hoverId || 0);

// Picks and hovers for the recommendation engine, seen from one slot.
// exceptCell leaves that slot out, so a champion is never its own ally.
function draftContext(d, exceptCell = null) {
  const others = (list) => list.filter((p) => p.cellId !== exceptCell && shownChamp(p));
  return {
    allies: others(d.ally).map((p) => ({ championId: shownChamp(p), position: p.position })),
    enemies: others(d.enemy).map((p) => ({ championId: shownChamp(p), position: p.position })),
  };
}

// The same, seen from the enemy side
function enemyContext(d, exceptCell) {
  const others = (list) => list.filter((p) => p.cellId !== exceptCell && shownChamp(p));
  return {
    allies: others(d.enemy).map((p) => ({ championId: shownChamp(p), position: p.position })),
    enemies: others(d.ally).map((p) => ({ championId: shownChamp(p), position: p.position })),
  };
}

// 50 is an average champion; 67 is one standard deviation above it, 80 two
// Recommendations look ahead (model.js); a pick losing (or gaining) this many points to the enemy's answers is flagged
const COUNTER_RISK_BADGE = 3;
// The player's own layer (their games on the champion) is shown from this many points
const PERSONAL_BADGE = 2;
// Personal layer of a player on the board, when they are in the team and analyzed
const personalOf = (playerId) => (playerId && S.playerStats?.[playerId]) || null;
const tierOf = (s) => (s >= 80 ? 'S' : s >= 67 ? 'A' : s >= 55 ? 'B' : s >= 40 ? 'C' : 'D');

// Notes on a recommendation, shown together in one icon's tooltip: [{ kind, title, text }]
// Champions this high in their role's pick rates are flagged as meta (information only)
const META_RANK = 5;

function recNotes(r) {
  const notes = [];
  if (r.popRank && r.popRank <= META_RANK) {
    notes.push({
      kind: '',
      title: `Meta: #${r.popRank} most picked`,
      text: `Picked by ${(r.pickRate * 100).toFixed(1)}% of teams in this role. Popularity does not count in the score, which is about winning.`,
    });
  }
  if (r.offRole) notes.push({ kind: 'warn', title: 'Off-role', text: 'Rarely played in this role.' });
  if (r.unsure && !r.offRole) notes.push({ kind: '', title: 'Low data', text: `Few games behind it: rough estimate, ±${r.uncertainty} points.` });
  if (Math.abs(r.personal || 0) >= PERSONAL_BADGE) {
    notes.push({
      kind: r.personal > 0 ? 'good' : 'warn',
      title: `You ${r.personal > 0 ? '+' : '−'}${Math.abs(r.personal)}`,
      text: r.personalGames
        ? `From your ${r.personalGames} games on it, compared with how you usually play.`
        : 'You have not played it: champions you rarely play go worse for you.',
    });
  }
  if (r.counterRisk >= COUNTER_RISK_BADGE) {
    notes.push({ kind: 'warn', title: `Counter risk −${r.counterRisk}`, text: 'Easy to answer: expected loss once the enemy picks in the roles they have open.' });
  }
  if (r.counterRisk <= -COUNTER_RISK_BADGE) {
    notes.push({ kind: 'good', title: `Safe blind +${-r.counterRisk}`, text: 'What the enemy usually picks in their open roles does badly against it.' });
  }
  return notes;
}

function notesIcon(notes) {
  if (!notes.length) return '';
  const kind = notes.some((n) => n.kind === 'warn') ? 'warn' : notes.every((n) => n.kind === 'good') ? 'good' : '';
  return `
    <span class="note-icon ${kind}" aria-label="${esc(notes.map((n) => n.title).join(', '))}">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm0 5.25a.75.75 0 0 0-.75.75v3.75a.75.75 0 0 0 1.5 0V7.5A.75.75 0 0 0 8 6.75Zm0-2.5a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z"/></svg>
      <span class="tip">${notes.map((n) => `<span class="tip-row ${n.kind}"><b>${esc(n.title)}</b>${esc(n.text)}</span>`).join('')}</span>
    </span>`;
}

function recRow(r, i, { canHover, hoverId, rank }) {
  const tier = tierOf(r.score);
  const hovering = r.championId === hoverId;
  return `
    <button type="button" class="rec ${hovering ? 'hovering' : ''} ${r.unsure ? 'unsure' : ''}" data-hover="${r.championId}"
      ${canHover ? '' : 'disabled'}>
      <span class="rank">${rank ?? i + 1}</span>
      ${champImg(r.championId)}
      <span class="info">
        <span class="name">${esc(champName(r.championId))}
          <span class="tier t-${tier}">${tier}</span>
          ${notesIcon(recNotes(r))}
          ${hovering ? '<span class="badge live">Hovering</span>' : ''}
        </span>
      </span>
      <span class="score"><b class="sc sc-${tierOf(r.score)}">${r.score}</b><i class="bar-${tierOf(r.score)}" data-w="${r.score}"></i></span>
    </button>`;
}

// A ban suggestion: score 0-100 for how much banning it helps (see model.js)
function banRow(r, i, { canHover, hoverId }) {
  const tier = tierOf(r.score);
  const hovering = r.championId === hoverId;
  const pct = r.pickChance * 100;
  return `
    <button type="button" class="rec ban ${hovering ? 'hovering' : ''}" data-hover="${r.championId}" data-kind="ban"
      ${canHover ? 'title="Hover this ban in the client"' : 'disabled'}>
      <span class="rank">${i + 1}</span>
      ${champImg(r.championId)}
      <span class="info">
        <span class="name">${esc(champName(r.championId))}
          <span class="badge">${ROLE_NAME[r.role] || ''}</span>
          <span class="badge" title="How often a team picks it there when it is not banned">Picked ${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%</span>
          ${hovering ? '<span class="badge live">Hovering</span>' : ''}
        </span>
      </span>
      <span class="score"><b class="sc sc-${tier}">${r.score}</b><i class="bar-${tier}" data-w="${r.score}"></i></span>
    </button>`;
}

// Our side for ban suggestions: picks and pick intents, and for a teammate who has not
// shown one yet, the champion they play most in their role this patch (their history
// statistics), so bans go to what beats the champions our players actually play
function banAllies(d, blocked) {
  const out = draftContext(d).allies;
  const taken = new Set(out.map((p) => p.championId));
  for (const p of d.ally) {
    if (shownChamp(p) || !p.position) continue;
    const id = p.isLocal ? S.me?.id : memberByPuuid(p.puuid)?.id;
    const byKey = (S.playerStats?.[id] || {}).history?.byKey || {};
    const usual = Object.entries(byKey)
      .map(([key, v]) => ({ championId: Number(key.split(':')[0]), role: key.split(':')[1], games: v.games }))
      .filter((x) => x.role === p.position && !blocked.has(x.championId) && !taken.has(x.championId))
      .sort((a, b) => b.games - a.games)[0];
    if (usual) {
      out.push({ championId: usual.championId, position: p.position });
      taken.add(usual.championId);
    }
  }
  return out;
}

// Score each champion had when it was locked, to show how later picks changed it
const pickScores = { gameId: null, map: new Map() };

// Score of a champion on the board, against everything locked so far.
// Enemy champions are scored from the enemy side: their allies are the enemy picks.
function slotScore(d, which, p, championId, sink) {
  const isAlly = which === 'ally';
  const ev = Engine.evaluate({
    stats: S.stats, model: S.model,
    championId,
    role: p.position || '',
    ...(isAlly ? draftContext(d, p.cellId) : enemyContext(d, p.cellId)),
    // A hover on our side is scored like the recommendations: after the enemy's answers
    lookAhead: isAlly && !p.locked,
    unavailable: unavailable(d),
    personal: isAlly ? personalOf(p.isLocal ? S.me?.id : memberByPuuid(p.puuid)?.id) : null,
  });
  if (!ev) return '';
  sink.push(ev.score);

  if (pickScores.gameId !== d.gameId) {
    pickScores.gameId = d.gameId;
    pickScores.map.clear();
  }
  const key = `${which}:${p.cellId}`;
  if (p.locked && !pickScores.map.has(key)) pickScores.map.set(key, ev.score);
  const atPick = pickScores.map.get(key);
  const changed = p.locked && atPick !== undefined && atPick !== ev.score;

  const label = changed
    ? `<small class="${ev.score > atPick ? 'up' : 'down'}">picked at ${atPick}</small>`
    : ev.offRole ? '<small class="warn">off-role</small>' : p.locked ? '' : '<small>if picked</small>';
  return `
    <div class="slot-score ${p.locked ? '' : 'pending'} ${ev.unsure ? 'unsure' : ''}"${ev.unsure ? ` title="Rough estimate: ±${ev.uncertainty} points"` : ''}>
      <b class="sc sc-${tierOf(ev.score)}">${ev.score}</b>
      ${label}
    </div>`;
}

// The draft with every player's role: known roles kept, the others (the enemy's, hidden
// in ranked) guessed from the champions shown, so slots sit in role order and the
// scores use the likely role
function withRoles(draft) {
  if (!draft) return draft;
  const side = (list) => {
    const guess = Engine.guessRoles({ model: S.model, players: list.map((p) => ({ championId: shownChamp(p), position: p.position })) });
    if (!guess) return list;
    // An empty slot gets the role left over only for ordering; it shows no role
    return list.map((p, i) => ({ ...p, position: guess.roles[i], roleGuessed: guess.guessed[i] && !!shownChamp(p), roleHidden: guess.guessed[i] && !shownChamp(p) }));
  };
  return { ...draft, ally: side(draft.ally), enemy: side(draft.enemy) };
}

function renderDraft() {
  clearInterval(timerHandle);
  const d = withRoles(S.draft);
  if (!d) {
    const connected = S.lcu?.connected;
    $view.innerHTML = `
      <div class="empty-state">
        <h2>${connected ? 'Waiting for champ select' : 'League client is closed'}</h2>
        <p>${connected
          ? 'Queue up. When champ select starts, the draft shows up here live with your recommendations.'
          : 'Open the League of Legends client. The app finds it and connects on its own.'}</p>
        ${S.stats?.meta?.length ? '' : '<p>No meta data yet. Recommendations appear after the collector runs for the first time.</p>'}
      </div>`;
    return;
  }

  const blocked = unavailable(d);
  const turnText = !d.turn
    ? d.phase === 'FINALIZATION' ? 'Finalization' : 'Waiting'
    : d.isOurTurn
      ? d.turn.kind === 'ban' ? 'Your turn to ban' : 'Your turn to pick'
      : `${d.turn.side === 'ally' ? 'Your team is' : 'Enemy is'} ${d.turn.kind === 'ban' ? 'banning' : 'picking'}`;

  // Our team is always on the left, whichever side we play
  const allyCol = sideColumn('ally', d);
  const enemyCol = sideColumn('enemy', d);

  const local = d.ally.find((p) => p.isLocal);
  const role = local?.position || '';
  const hasStats = S.stats?.meta?.length > 0;
  const recs = local?.locked
    ? []
    : Engine.recommend({
        stats: S.stats, model: S.model,
        role,
        // Teammates' hovers are taken too: don't suggest what a friend is about to pick
        unavailable: new Set([...blocked, ...d.ally.filter((p) => !p.isLocal && shownChamp(p)).map(shownChamp)]),
        pickable: S.pickable,
        ...draftContext(d, local?.cellId),
        pool: myPool().map((p) => p.champion_id),
        limit: 10,
        personal: personalOf(S.me?.id),
      });

  // Our ban is still open: what to ban, against our picks and intents and their locks
  const bans = d.myBanActionId
    ? Engine.recommendBans({
        model: S.model,
        unavailable: blocked,
        allies: banAllies(d, blocked),
        enemies: d.enemy.filter((p) => p.locked && p.championId).map((p) => ({ championId: p.championId, position: p.position })),
        limit: 10,
      })
    : [];
  const banBlock = d.myBanActionId
    ? `<div>
        <h3 class="sub head-row">
          <span>Ban suggestions</span>
          ${bans.length ? '<span class="hint">Click to hover the ban in the client</span>' : ''}
        </h3>
        ${bans.length
          ? `<div class="recs" data-kind="ban">${bans.map((r, i) => banRow(r, i, { canHover: true, hoverId: d.banHoverId })).join('')}</div>`
          : '<p class="note">Ban suggestions need the learned model; they appear after the next training.</p>'}
      </div>`
    : '';

  // After locking: your pick with its live breakdown
  let pickRow = '';
  if (local?.locked) {
    const ev = Engine.evaluate({ stats: S.stats, model: S.model, championId: local.championId, role, ...draftContext(d, local.cellId), personal: personalOf(S.me?.id) });
    if (ev) pickRow = `<div class="recs pinned">${recRow({ ...ev, inPool: false }, 0, { canHover: false, rank: '✓' })}</div>`;
  }

  // The champion you are hovering, if it is not already in the list
  let hoverRow = '';
  if (local && !local.locked && local.hoverId && !recs.some((r) => r.championId === local.hoverId)) {
    const ev = Engine.evaluate({
      stats: S.stats, model: S.model, championId: local.hoverId, role, ...draftContext(d, local.cellId),
      lookAhead: true, unavailable: blocked, personal: personalOf(S.me?.id),
    });
    if (ev) {
      const row = { ...ev, inPool: myPool().some((p) => p.champion_id === local.hoverId) };
      hoverRow = `<h3 class="sub gap">Your hover</h3><div class="recs pinned">${recRow(row, 0, { canHover: false, hoverId: local.hoverId, rank: '•' })}</div>`;
    }
  }

  $view.innerHTML = `
    <div class="board">
      ${allyCol}
      <section class="center">
        <div class="phasebox ${d.isOurTurn ? 'mine' : ''}">
          <div class="turn-row">
            <div class="turn ${d.isOurTurn ? 'mine' : ''}">${esc(turnText)}</div>
            <div class="secs" id="tsec"></div>
          </div>
          <div class="timer"><div id="tbar"></div></div>
        </div>
        ${banBlock}
        <div>
          <h3 class="sub head-row">
            <span>${local?.locked ? `Your pick: ${esc(champName(local.championId))}` : `Recommended${role ? ' · ' + ROLE_NAME[role] : ''}`}</span>
            ${!local?.locked && d.myPickActionId && recs.length ? '<span class="hint">Click to hover in the client</span>' : ''}
          </h3>
          ${local?.locked ? pickRow : recs.length
            ? `<div class="recs">${recs.map((r, i) => recRow(r, i, { canHover: !!d.myPickActionId, hoverId: local?.hoverId })).join('')}</div>${hoverRow}`
            : `<p class="note">${hasStats
                ? 'No pickable champions left for this role.'
                : 'No meta data yet. Recommendations appear here after the collector runs.'}</p>`}
        </div>
      </section>
      ${enemyCol}
    </div>`;

  // Inline style attributes are blocked by the CSP, so bar widths are set here
  for (const bar of $view.querySelectorAll('[data-w]')) bar.style.width = `${bar.dataset.w}%`;
  // Pick and ban lists: a click hovers the champion for that action in the client
  for (const list of $view.querySelectorAll('.recs')) {
    list.onclick = async (e) => {
      const b = e.target.closest('[data-hover]');
      if (!b || b.disabled) return;
      for (const x of list.querySelectorAll('.rec.hovering')) x.classList.remove('hovering');
      b.classList.add('hovering', 'sending');
      try {
        await run(api.hoverChampion(Number(b.dataset.hover), b.dataset.kind === 'ban' ? 'ban' : 'pick'));
      } catch {
        b.classList.remove('hovering');
      } finally {
        b.classList.remove('sending');
      }
    };
  }

  // Countdown bar and seconds
  if (d.endsAt) {
    const total = Math.max(d.endsAt - Date.now(), 1);
    const bar = document.getElementById('tbar');
    const secs = document.getElementById('tsec');
    const tick = () => {
      const left = Math.max(d.endsAt - Date.now(), 0);
      if (bar) bar.style.width = `${(left / total) * 100}%`;
      if (secs) secs.textContent = Math.ceil(left / 1000);
    };
    tick();
    timerHandle = setInterval(tick, 250);
  }
}

function sideColumn(which, d) {
  const isAlly = which === 'ally';
  const color = isAlly ? d.ourSide : d.ourSide === 'blue' ? 'red' : 'blue';
  const players = isAlly ? d.ally : d.enemy;
  const bans = isAlly ? d.allyBans : d.enemyBans;
  const blocked = unavailable(d);
  const acting = new Set(d.turn && d.turn.side === which ? d.turn.cellIds : []);
  const scores = [];

  // In role order (top to support); players without a role yet keep their place at the end
  const order = (p) => (p.position && ROLE_NAME[p.position] ? ROLES.findIndex(([k]) => k === p.position) : 9);
  const slots = [...players].sort((a, b) => order(a) - order(b)).map((p) => {
    const m = isAlly ? memberByPuuid(p.puuid) : null;
    const shown = p.locked ? p.championId : p.hoverId || 0;
    // Same as the client: roles of our team; enemy roles are hidden in ranked
    const roleLabel = p.roleHidden ? '' : ROLE_NAME[p.position] || '';
    let mini = '';
    // 3 suggestions for a teammate who has not picked yet
    if (isAlly && !p.isLocal && !p.locked && !shown && m) {
      // We cannot know what a teammate owns; use their pool if they have one, else everything
      const theirPool = S.pools.filter((x) => x.player_id === m.id).map((x) => x.champion_id);
      const picks = Engine.recommend({
        stats: S.stats, model: S.model, role: p.position, unavailable: blocked, pickable: theirPool.length ? theirPool : null,
        ...draftContext(d, p.cellId), limit: 3,
      });
      mini = `<div class="mini">${picks.map((r) => champImg(r.championId, 's')).join('')}</div>`;
    }
    const cls = ['slot', p.isLocal ? 'me' : '', acting.has(p.cellId) ? 'acting' : '', !p.locked && shown ? 'hover' : ''].join(' ');
    return `
      <div class="${cls}">
        ${champImg(shown, 'l')}
        <div class="who">
          <div class="name">${esc(shown ? champName(shown) : '…')}</div>
          ${roleLabel ? `<div class="role"${p.roleGuessed ? ' title="Estimated from the champion"' : ''}>${roleLabel}${p.roleGuessed ? '?' : ''}</div>` : ''}
        </div>
        ${shown ? slotScore(d, which, p, shown, scores) : mini}
      </div>`;
  });

  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  return `
    <section class="side ${color}">
      <div class="side-head">
        <h2>${isAlly ? 'Your team' : 'Enemy team'}</h2>
        ${avg === null ? '' : `<div class="avg" title="Average score of the champions shown"><small>avg</small><b class="sc sc-${tierOf(avg)}">${avg}</b></div>`}
        <span>${color === 'blue' ? 'Blue side' : 'Red side'}</span>
      </div>
      ${slots.join('')}
      <div class="bans">${bans.length ? bans.map((id) => champImg(id, 's')).join('') : '<span class="note">No bans</span>'}</div>
    </section>`;
}

// ---------- Champions ----------
// How each player does on each champion (collector/src/players), from two kinds of games:
// their own games of the patch, and the team's full Flex games. Games, record, and the
// effect split into the laning phase and the rest of the game
function renderChampions() {
  const members = S.members || [];
  const id = statsUi.player && members.some((m) => m.id === statsUi.player) ? statsUi.player : S.me?.id;
  const source = STAT_SOURCES.find(([k]) => k === statsUi.source) || STAT_SOURCES[0];
  const stats = ((S.playerStats || {})[id] || {})[source[0]];
  const pts = (x) => Engine.points(S.model, x);
  const signed = (n) => `<b class="${n > 0 ? 'up' : n < 0 ? 'down' : ''}">${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}</b>`;
  const rows = stats
    ? Object.entries(stats.byKey)
        .map(([key, v]) => ({ championId: Number(key.split(':')[0]), role: key.split(':')[1], ...v }))
        .sort((x, y) => y.games - x.games || y.delta - x.delta)
    : [];
  $view.innerHTML = `
    <div class="champ-stats">
      <div class="toolbar">
        <h2>Champion Statistics</h2>
        <div class="seg" id="src">${STAT_SOURCES.map(([k, label]) => `<button data-src="${k}" class="${k === source[0] ? 'active' : ''}">${label}</button>`).join('')}</div>
        <span class="grow"></span>
        <select id="who">${members.map((m) => `<option value="${m.id}" ${m.id === id ? 'selected' : ''}>${esc(m.nickname)}${m.id === S.me?.id ? ' (you)' : ''}</option>`).join('')}</select>
      </div>
      ${rows.length
        ? `<div class="stats-table">
            <div class="stats-row head"><span>Champion</span><span>Games</span><span>Record</span><span title="Laning phase compared with an average player in the same matchup">Lane</span><span title="The rest of the game, beyond the draft and the lane">Rest</span><span title="What it adds to this player's score for the champion">Effect</span></div>
            ${rows.map((r) => `
              <div class="stats-row">
                <span class="who">${champImg(r.championId)}<span><b>${esc(champName(r.championId))}</b><small>${esc(ROLE_NAME[r.role] || r.role)}</small></span></span>
                <span>${r.games}</span>
                <span>${r.wins}–${r.games - r.wins} <small>${Math.round((100 * r.wins) / r.games)}%</small></span>
                <span>${signed(pts(r.early))}</span>
                <span>${signed(pts(r.late))}</span>
                <span>${signed(pts(r.delta))}</span>
              </div>`).join('')}
          </div>
          <p class="note">Champions not played here: ${signed(pts(stats.unplayed))}</p>`
        : '<p class="note">No games yet.</p>'}
    </div>`;
  document.getElementById('src').onclick = (e) => {
    const b = e.target.closest('[data-src]');
    if (!b) return;
    statsUi.source = b.dataset.src;
    renderChampions();
  };
  document.getElementById('who').onchange = (e) => {
    statsUi.player = e.target.value;
    renderChampions();
  };
}

// ---------- Team ----------
function renderTeam() {
  const t = S.team;
  const isOwner = t?.owner_id === S.me?.id;
  $view.innerHTML = `
    <div class="team-head">
      <h2>${esc(t?.name || '')}</h2>
      <span class="muted">Invite code</span><span class="code">${esc(t?.join_code || '')}</span>
      <button class="btn ghost" id="copy">Copy code</button>
      <span class="grow"></span>
      <button class="btn ghost" id="prof">Edit profile</button>
      <button class="btn ghost danger" id="reset">Reset my champion data</button>
      <button class="btn ghost" id="leave">Leave team</button>
      <button class="btn ghost" id="out">Sign out</button>
    </div>
    <div class="members">
      ${S.members.map((m) => {
        const owner = t?.owner_id === m.id;
        return `
          <div class="member">
            <div class="top">
              <span class="nick">${esc(m.nickname)}${m.id === S.me.id ? ' (you)' : ''}${owner ? ' <span class="badge owner">Owner</span>' : ''}</span>
            </div>
            <div class="muted small">${m.riot_id ? esc(m.riot_id) : 'LoL account not linked yet'}</div>
            ${isOwner && m.id !== S.me.id ? `<button class="link kick" data-kick="${m.id}" data-name="${esc(m.nickname)}">Remove from team</button>` : ''}
          </div>`;
      }).join('')}
    </div>`;
  $view.querySelector('.members').onclick = async (e) => {
    const b = e.target.closest('[data-kick]');
    if (!b || !confirm(`Remove ${b.dataset.name} from the team?`)) return;
    S = await run(api.kickMember(b.dataset.kick));
    toast(`${b.dataset.name} was removed from the team`);
    renderMain();
  };
  document.getElementById('copy').onclick = () => navigator.clipboard.writeText(t.join_code).then(() => toast('Code copied'));
  document.getElementById('out').onclick = signOut;
  document.getElementById('prof').onclick = () => {
    screen = 'profile';
    render();
  };
  document.getElementById('reset').onclick = async () => {
    const ok = confirm(
      'Reset your champion data?\n\nYour champion statistics are deleted and every game you played until now stops counting for you. ' +
        'Only games from now on will build them up again. This cannot be undone.',
    );
    if (!ok) return;
    S = await run(api.resetChampionStats());
    toast('Your champion data was reset');
    renderMain();
  };
  document.getElementById('leave').onclick = async () => {
    if (!confirm('Are you sure you want to leave the team?')) return;
    S = await run(api.leaveTeam());
    decideScreen();
  };
}

// ---------- History ----------
async function renderHistory() {
  $view.innerHTML = '<p class="note">Loading…</p>';
  const rows = await run(api.listHistory());
  if (tab !== 'history') return;
  if (!rows.length) {
    $view.innerHTML = '<div class="empty-state"><h2>No games yet</h2></div>';
    return;
  }
  const picks = (r, side) =>
    r.draft_actions.filter((a) => a.side === side && a.kind === 'pick').sort((a, b) => a.seq - b.seq).map((a) => champImg(a.champion_id, 's')).join('');
  const statusText = { live: 'In progress', played: 'Played', dodged: 'Dodged', finished: '' };
  $view.innerHTML = `
    <div class="hist">
      ${rows.map((r) => `
        <div class="hrow">
          <span class="muted">${new Date(r.started_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</span>
          <span class="tag ${r.our_side || ''}">${r.our_side === 'red' ? 'Red' : 'Blue'}</span>
          <span class="${r.result || 'muted'}">${r.result === 'win' ? 'Win' : r.result === 'loss' ? 'Loss' : statusText[r.status] || ''}</span>
          <div class="icons">${picks(r, 'ally')}</div>
          <div class="icons">${picks(r, 'enemy')}</div>
        </div>`).join('')}
    </div>`;
}

boot();
