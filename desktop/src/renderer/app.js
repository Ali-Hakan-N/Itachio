/* global api, Engine, Traits */
// UI. State comes from the main process (api.onState); this file only renders and sends requests.

const ROLES = [
  ['top', 'Top'],
  ['jungle', 'Jungle'],
  ['middle', 'Mid'],
  ['bottom', 'Bot'],
  ['utility', 'Support'],
];
const ROLE_NAME = Object.fromEntries(ROLES);
// Lane icons: the map with the role's lane (or a fang for jungle, a shield for support)
const ROLE_ICON = {
  top: '<path d="M1 1h11L9 4H4v5l-3 3z"/><path class="faint" d="M15 15H6l2-2h5V8l2-2z"/>',
  jungle: '<path d="M8 1c.6 2.6 3.8 4.6 3.8 8.6A3.8 3.8 0 0 1 8 13.4a3.8 3.8 0 0 1-3.8-3.8C4.2 5.6 7.4 3.6 8 1z"/><path class="faint" d="M3 15l2.4-3.4M13 15l-2.4-3.4"/>',
  middle: '<path d="M12 1h3v3L4 15H1v-3z"/><path class="faint" d="M1 1h5L1 6zM15 15h-5l5-5z"/>',
  bottom: '<path d="M15 15H4l3-3h5V7l3-3z"/><path class="faint" d="M1 1h9L8 3H3v5L1 10z"/>',
  utility: '<path d="M8 1.5l5.8 2.2v4.1c0 3.4-2.4 5.8-5.8 6.7-3.4-.9-5.8-3.3-5.8-6.7V3.7z"/><path class="faint" d="M8 5v6M5 8h6"/>',
};
const roleIcon = (r) => `<svg viewBox="0 0 16 16" aria-hidden="true">${ROLE_ICON[r] || ''}</svg>`;

const PHASE_TEXT = {
  None: 'Idle',
  Lobby: 'In Lobby',
  Matchmaking: 'In Queue',
  ReadyCheck: 'Match Found',
  ChampSelect: 'Champ Select',
  GameStart: 'Loading Game',
  InProgress: 'In Game',
  WaitingForStats: 'Waiting for Stats',
  PreEndOfGame: 'Game Over',
  EndOfGame: 'Post Game',
};

let S = null; // state from the main process
let tab = 'draft';
let screen = 'loading'; // loading | config | login | profile | team | main
let configError = null;
// Whose champion statistics are shown (default: me), from which games, and for the team
// games which line-up of team members
const statsUi = { player: null, source: 'season', lineup: null };
const STAT_SOURCES = [
  ['season', 'This Season'], // the player's ranked games of the season
  ['history', 'This Patch'], // the same, of the current patch
  ['team', 'With the Team'], // their games with five team members on their side, per line-up
];
// Whose games the History tab shows (default: me)
const historyUi = { player: null, rows: [], more: false, html: new Map() };
const HISTORY_PAGE = 10;

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
          <img class="seal big" src="logo.png" alt="" aria-hidden="true">
          <h2>Installing Update</h2>
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
api.onAuthRecovery((result) => {
  screen = 'login';
  if (result.ok) renderLogin('recovery');
  else {
    renderLogin('signin');
    toast(result.error || 'This password recovery link is invalid or expired', 'error');
  }
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
  if (init.passwordRecoveryError) {
    screen = 'login';
    render();
    return toast(init.passwordRecoveryError, 'error');
  }
  if (init.passwordRecovery) {
    screen = 'login';
    return renderLogin('recovery');
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
  for (const id of ['ver', 'railver']) {
    const el = document.getElementById(id);
    if (el) el.textContent = appVersion ? `v${appVersion}` : '';
  }
}

api.onState((partial) => {
  if (!S) S = {};
  Object.assign(S, partial);
  if (screen === 'main' && 'me' in partial && !partial.me?.team_id) return decideScreen();
  renderStatus();
  // Keep focus while typing on the pool screen: re-render only the affected parts
  if (screen !== 'main') return;
  if (tab === 'draft' && ['draft', 'pools', 'lcu', 'members', 'model', 'currentBuild', 'applied', 'gameData', 'lastGame'].some((k) => k in partial)) renderMain();
  if (tab === 'team' && ('members' in partial || 'pools' in partial || 'team' in partial || 'me' in partial)) renderMain();
  if (tab === 'champions' && ('playerStats' in partial || 'members' in partial || 'model' in partial)) renderMain();
});
api.onSaved((info) => {
  if (info.type === 'match') toast('Match result and draft saved');
});

// ---------- Menu ----------
const ICONS = {
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  users: '<circle cx="9" cy="9" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5M15 15c3 0 6 1.5 6 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
// The three statistics sources are inputs of the scores: each has its own entry
const MENU = [
  { id: 'draft', title: 'Draft', items: [{ tab: 'draft', label: 'Draft Assistant', hint: 'Live picks and bans', icon: 'target' }] },
  { id: 'players', title: 'Players', items: [
    { tab: 'champions', src: 'season', label: 'This Season', hint: 'Scoring input', icon: 'calendar' },
    { tab: 'champions', src: 'history', label: 'This Patch', hint: 'Scoring input', icon: 'layers' },
    { tab: 'champions', src: 'team', label: 'With the Team', hint: 'Scoring input', icon: 'users' },
    { tab: 'history', label: 'Match History', icon: 'clock' },
  ] },
  { id: 'team', title: 'Team', items: [{ tab: 'team', label: 'Roster', hint: 'Members and roles', icon: 'shield' }] },
];
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const menuCollapsed = new Set(store.get('menu.collapsed', []));

function buildMenu() {
  $tabs.innerHTML = MENU.map((g) => `
    <div class="menu-group ${menuCollapsed.has(g.id) ? 'collapsed' : ''}" data-group="${g.id}">
      <button type="button" class="menu-head" data-head="${g.id}" aria-expanded="${!menuCollapsed.has(g.id)}">${g.title}${icon('chevron')}</button>
      <div class="menu-items">${g.items.map((it) => `
        <button type="button" class="menu-item" data-tab="${it.tab}" ${it.src ? `data-src="${it.src}"` : ''}>
          ${icon(it.icon)}<span>${it.label}${it.hint ? `<small>${it.hint}</small>` : ''}</span>
        </button>`).join('')}
      </div>
    </div>`).join('');
}
function markMenu() {
  for (const b of $tabs.querySelectorAll('[data-tab]')) {
    const active = b.dataset.tab === tab && (!b.dataset.src || (tab === 'champions' && b.dataset.src === statsUi.source));
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
}
buildMenu();
$tabs.addEventListener('click', (e) => {
  const head = e.target.closest('[data-head]');
  if (head) {
    const group = head.closest('.menu-group');
    const collapsed = group.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!collapsed));
    if (collapsed) menuCollapsed.add(group.dataset.group);
    else menuCollapsed.delete(group.dataset.group);
    store.set('menu.collapsed', [...menuCollapsed]);
    return;
  }
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  if (b.dataset.src) statsUi.source = b.dataset.src;
  renderMain();
});
function setMenu(open) {
  document.body.classList.toggle('menu-closed', !open);
  document.getElementById('menutoggle').setAttribute('aria-expanded', String(open));
  store.set('menu.open', open);
}
setMenu(store.get('menu.open', true));
document.getElementById('menutoggle').onclick = () => setMenu(document.body.classList.contains('menu-closed'));

// ---------- rendering ----------
const splashHtml = (text) => `
  <div class="splash">
    <div class="splash-seal">
      <svg class="splash-ring" viewBox="-12 -12 24 24" aria-hidden="true">
        <circle r="11" class="ring-line"/>
        <use href="#tomoe"/><use href="#tomoe" transform="rotate(120)"/><use href="#tomoe" transform="rotate(240)"/>
      </svg>
      <img src="logo.png" alt="">
    </div>
    <h1 class="splash-word">ITACHIO</h1>
    <p class="splash-line">${esc(text)}</p>
    <div class="splash-bar"><i></i></div>
  </div>`;

function render() {
  document.body.dataset.screen = screen;
  document.getElementById('page-head').hidden = screen !== 'main';
  renderStatus();
  if (screen === 'loading') $view.innerHTML = splashHtml('Gathering your team and the model…');
  if (screen === 'config') renderConfig();
  if (screen === 'login') renderLogin();
  if (screen === 'profile') renderProfile();
  if (screen === 'team') renderTeamSetup();
  if (screen === 'main') renderMain();
}

function renderStatus() {
  const warning = document.getElementById('metasrc-warning');
  warning.hidden = screen !== 'main' || !S?.metaSrcHealth?.stale;
  warning.textContent = 'MetaSRC snapshot data has not refreshed in 72 hours';
  const l = S?.lcu;
  if (!l) return ($status.innerHTML = '');
  const acct = l.summoner?.riotId ? ` · ${esc(l.summoner.riotId)}` : '';
  $status.innerHTML = l.connected
    ? `<span class="dot on"></span><span><b>Eyes open</b><small>${esc(PHASE_TEXT[l.phase] || l.phase)}${acct}</small></span>`
    : `<span class="dot"></span><span><b>The Rift is quiet</b><small>Open League to awaken Itachio</small></span>`;
}

function renderConfig() {
  $view.innerHTML = `
    <div class="card">
      <h2>Setup Incomplete</h2>
      <p>${esc(configError)}</p>
      <p>Copy <b>config.example.json</b> in the app folder to <b>config.json</b>,
      fill in your Supabase project URL and key, then restart the app.</p>
    </div>`;
}

function renderLogin(mode = 'signin') {
  const signup = mode === 'signup';
  const forgot = mode === 'forgot';
  const recovery = mode === 'recovery';
  if (recovery) {
    $view.innerHTML = `
      <form class="card" id="f">
        <h2>Choose a New Password</h2>
        <label>New password <input name="password" type="password" required minlength="6" autocomplete="new-password"></label>
        <label>Confirm password <input name="confirmPassword" type="password" required minlength="6" autocomplete="new-password"></label>
        <div class="err" id="err"></div>
        <button class="btn primary" type="submit">Update Password</button>
      </form>`;
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      const err = document.getElementById('err');
      if (fd.password !== fd.confirmPassword) return (err.textContent = 'Passwords do not match');
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      const res = await api.updatePassword({ password: fd.password });
      btn.disabled = false;
      if (!res.ok) return (err.textContent = res.error);
      await loadAll();
      toast('Password updated');
    };
    return;
  }
  $view.innerHTML = `
    <form class="card" id="f">
      <h2>${signup ? 'Create Account' : forgot ? 'Reset Password' : 'Sign In'}</h2>
      <label>Email <input name="email" type="email" required autocomplete="email"></label>
      ${forgot ? '' : `<label>Password <input name="password" type="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>`}
      <div class="err" id="err"></div>
      <button class="btn primary" type="submit">${signup ? 'Create Account' : forgot ? 'Send Reset Link' : 'Sign In'}</button>
      ${forgot
        ? '<button class="link" type="button" id="back">Back to sign in</button>'
        : `<button class="link" type="button" id="swap">${signup ? 'Have an account? Sign in' : 'No account? Create one'}</button>${signup ? '' : '<button class="link" type="button" id="forgot">Forgot password?</button>'}`}
    </form>`;
  if (forgot) document.getElementById('back').onclick = () => renderLogin('signin');
  else {
    document.getElementById('swap').onclick = () => renderLogin(signup ? 'signin' : 'signup');
    if (!signup) document.getElementById('forgot').onclick = () => renderLogin('forgot');
  }
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    const res = await (signup ? api.signUp(fd) : forgot ? api.requestPasswordReset(fd) : api.signIn(fd));
    btn.disabled = false;
    if (!res.ok) return (document.getElementById('err').textContent = res.error);
    if (forgot) {
      renderLogin('signin');
      return toast('If an account exists for this email, a reset link has been sent');
    }
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
      <h2>Player Profile</h2>
      <p>Your teammates will see you by this name. Your LoL account links automatically while the client is open.</p>
      <label>Nickname <input name="nickname" required minlength="2" maxlength="32" value="${esc(me?.nickname || S?.lcu?.summoner?.riotId?.split('#')[0] || '')}"></label>
      <button class="btn primary" type="submit">Save Profile</button>
      ${me ? '' : '<button class="link" type="button" id="out">Sign Out</button>'}
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
      <h2>Join Your Team</h2>
      <p>Enter the 8-character code from a teammate.</p>
      <form class="row" id="join"><input name="code" placeholder="Team code" required class="grow upper"><button class="btn primary">Join</button></form>
      <p class="gap">First one on the team? Create it and share the code with your friends.</p>
      <form class="row" id="create"><input name="name" placeholder="Team name" required minlength="2" class="grow"><button class="btn">Create Team</button></form>
      <button class="link" type="button" id="out">Sign Out</button>
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
  const sourceName = (STAT_SOURCES.find(([k]) => k === statsUi.source) || STAT_SOURCES[0])[1];
  const pages = {
    draft: ['LIVE DRAFT', 'Draft Assistant'],
    champions: ['PLAYER ANALYTICS', `Champions \u00b7 ${sourceName}`],
    team: ['ROSTER', S.team?.name || 'Team'],
    history: ['MATCH ARCHIVE', 'Match History'],
  };
  const [kicker, title] = pages[tab] || pages.draft;
  document.getElementById('page-kicker').textContent = kicker;
  document.getElementById('page-title').textContent = title;
  markMenu();
  const user = document.getElementById('rail-player');
  user.innerHTML = `<span class="rail-avatar">${esc((S.me?.nickname || '?').slice(0, 1).toUpperCase())}</span><span><b>${esc(S.me?.nickname || 'Player')}</b><small>${esc(S.me?.riot_id || 'Account')}</small></span>`;
  if (tab !== 'champions') {
    lineupPickerCleanup?.();
    lineupPickerCleanup = null;
  }
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
    // Enemy picks that come after this slot's can answer it; the others cannot
    answerShare: Engine.answerShare?.(d.pickSequence, exceptCell) ?? 1,
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
// Team members on our side of the draft (their player ids, me included)
const draftLineup = (d) => (d?.ally || []).map((p) => (p.isLocal ? S.me?.id : memberByPuuid(p.puuid)?.id)).filter(Boolean);
// Personal layer of a player on the board, when they are in the team and analyzed: their
// season and patch statistics, and those with the team members on our side now
const personalOf = (playerId, d) => Engine.personalFor(
  S.playerStats,
  playerId,
  draftLineup(d),
  (championId) => S.champions?.find((champion) => champion.id === championId)?.tags?.[0] || S.model?.tags?.[championId] || 'None',
);
const tierOf = (s) => (s >= 80 ? 'S' : s >= 67 ? 'A' : s >= 55 ? 'B' : s >= 40 ? 'C' : 'D');

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
          ${Number.isFinite(r.blindSpread) ? `<span class="badge" title="Standard deviation of odds-ratio-adjusted lane matchups after subtracting estimated sampling noise.">Spread ${(r.blindSpread * 100).toFixed(1)}pp</span>` : ''}
          ${Number.isFinite(r.counterChance) ? `<span class="badge ${r.counterChance >= 0.5 ? 'warn' : 'good'}" title="Chance an average 7-champion pool for this role contains a matchup at least 2 percentage points worse than expected, weighted by current pick rates.">Pool counter ${Math.round(r.counterChance * 100)}%</span>` : ''}
          ${hovering ? '<span class="badge live">Hovering</span>' : ''}
        </span>
      </span>
      <span class="score"><b class="sc sc-${tierOf(r.score)}">${r.score}</b><i class="bar-${tierOf(r.score)}" data-w="${r.score}"></i></span>
    </button>`;
}

// Recommendations as tiers of champion tiles, each with its score
const TIER_BANDS = [['S+', 85], ['S', 75], ['A', 65], ['B', 55], ['C', 45], ['D', 0]];
function tierGrid(recs, { canHover, hoverId }) {
  const groups = TIER_BANDS.map(([label, min]) => ({ label, min, rows: [] }));
  for (const r of recs) groups.find((g) => r.score >= g.min).rows.push(r);
  return `<div class="recs tiers">${groups.filter((g) => g.rows.length).map((g) => {
    const hi = Math.max(...g.rows.map((r) => r.score));
    const lo = Math.min(...g.rows.map((r) => r.score));
    return `<div class="tier-group">
      <div class="tier-head"><span class="tier t-${g.label[0]}">${g.label}</span><small>${lo === hi ? lo : `${lo}–${hi}`} · ${g.rows.length}</small></div>
      <div class="tier-tiles">${g.rows.map((r) => `
        <button type="button" class="tile ${r.championId === hoverId ? 'hovering' : ''} ${r.unsure ? 'unsure' : ''}" data-hover="${r.championId}" ${canHover ? '' : 'disabled'} title="${esc(champName(r.championId))} · ${r.score}">
          ${champImg(r.championId)}
          <span class="tname">${esc(champName(r.championId))}</span>
          <b class="tscore sc-${tierOf(r.score)}">${r.score}</b>
        </button>`).join('')}</div>
    </div>`;
  }).join('')}</div>`;
}

const NEED_NAME = { fr: 'frontline', cc: 'CC', en: 'engage', wc: 'waveclear', ac: 'AoE', pk: 'poke', pe: 'peel', sc: 'scaling', pi: 'pick', sp: 'split push' };

// Where the expected win chance of a pick comes from: each part in percentage points of win
// chance, added one after another from an even game so they sum to the final number
function modelExplanation(row) {
  if (!row?.parts) return '';
  const P = row.parts;
  const win = (z) => 100 / (1 + Math.exp(-z)) - 50;
  const icons = (items, sign) => (items || []).filter((x) => x.value * sign > 0).slice(0, 3).map((x) => champImg(x.championId, 's')).join('');
  const items = [
    { label: 'Champion strength', z: P.strength },
    { label: 'Team synergy', z: P.synergy + P.ahead, detail: icons(row.allies, P.synergy >= 0 ? 1 : -1) },
    { label: 'Enemy matchups', z: P.matchup, detail: icons(row.enemies, P.matchup >= 0 ? 1 : -1) },
    { label: 'AP / AD balance', z: P.damage },
    { label: 'CC, frontline, engage', z: P.needs, detail: row.lacking?.length ? `Missing ${row.lacking.map((k) => NEED_NAME[k] || k).join(', ')}` : '' },
    { label: 'Team coordination', z: P.coherence },
    { label: 'Enemy answers', z: P.exposure },
    { label: 'Lane', z: P.lane },
    { label: 'Personal fit', z: P.personal },
    { label: 'Other factors', z: P.learned + P.typical },
  ];
  let cum = 0;
  for (const it of items) {
    const before = win(cum);
    cum += it.z;
    it.pp = win(cum) - before;
  }
  const fmt = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
  const line = (it) => `<div class="wf-row ${it.pp > 0 ? 'up' : 'down'}">
    <span class="wf-label">${esc(it.label)}${it.detail ? `<small>${it.detail}</small>` : ''}</span>
    <div class="wf-track"><span class="neg"><i data-w="${it.pp < 0 ? Math.min(100, Math.abs(it.pp) * 25) : 0}"></i></span><span class="pos"><i data-w="${it.pp > 0 ? Math.min(100, it.pp * 25) : 0}"></i></span></div>
    <b>${fmt(it.pp)}</b>
  </div>`;
  const shown = items.filter((it) => Math.abs(it.pp) >= 0.05);
  const blind = Number.isFinite(row.blindSpread) && Number.isFinite(row.counterChance)
    ? `<div class="blind-summary"><span>Blind spread <b>${(row.blindSpread * 100).toFixed(1)}pp</b></span><span>7-pick pool counter <b>${Math.round(row.counterChance * 100)}%</b></span></div>`
    : '';
  const name = champName(row.championId);
  return `<section class="explanation" aria-label="Model breakdown for ${esc(name)}">
    <div class="explanation-head"><div><span class="page-kicker">WHY ${esc(name.toUpperCase())} · EXPECTED WIN CHANCE ${(50 + win(cum)).toFixed(1)}%</span></div><strong>${row.score}<small>/100</small></strong></div>
    <p class="wf-note">Each line moves the win chance, in percentage points: green up, red down.</p>
    <div class="wf-list">${shown.map(line).join('') || '<p class="note">No material effect</p>'}</div>
    <div class="wf-foot"><span>Even game <b>50.0%</b></span><span class="wf-arrow">›</span>${champImg(row.championId, 's')}<span>${esc(name)} <b>${(50 + win(cum)).toFixed(1)}%</b></span></div>
    ${blind}
  </section>`;
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

// A player's games per champion and role: the season's, else the patch's
function playedEntries(playerId) {
  const own = S.playerStats?.[playerId] || {};
  const byKey = (own.season || own.history)?.byKey || {};
  return Object.entries(byKey).map(([key, v]) => ({ championId: Number(key.split(':')[0]), role: key.split(':')[1], games: v.games, delta: v.delta, mastery: v.mastery || 0 }));
}

// Our side for ban suggestions: picks and pick intents, and for a teammate who has not
// shown one yet, the champion they know best in their role (games, weighted by mastery),
// so bans go to what beats the champions our players actually play
function banAllies(d, blocked) {
  const out = draftContext(d).allies;
  const taken = new Set(out.map((p) => p.championId));
  for (const p of d.ally) {
    if (shownChamp(p) || !p.position) continue;
    const id = p.isLocal ? S.me?.id : memberByPuuid(p.puuid)?.id;
    const usual = playedEntries(id)
      .filter((x) => x.role === p.position && !blocked.has(x.championId) && !taken.has(x.championId))
      .sort((a, b) => b.games * (1 + b.mastery) - a.games * (1 + a.mastery))[0];
    if (usual) {
      out.push({ championId: usual.championId, position: p.position });
      taken.add(usual.championId);
    }
  }
  return out;
}

// Who should pick first: teammates still to pick, ordered by role (which lanes the enemy
// can counter, which the jungle and bot lanes need to see first) and, for a teammate who
// hovers a champion, by how easily the enemy can answer it. No guess about who plays what.

// Safe champions a player has in a role (null without statistics, so nothing is assumed)
function poolDepthOf(playerId, role) {
  const entries = playedEntries(playerId);
  return entries.length ? Engine.poolDepth(entries.filter((e) => e.role === role)) : null;
}

const pickOrderUi = { gameId: null, order: null, pending: null, pendingKey: null, timer: null, hoverSignature: null };
const PICK_ORDER_STABILITY_MS = 1500;
const PICK_ORDER_HYSTERESIS = 2.5;

function stabilizedPickOrder(d, rated, suggested, teammateHoverChanged) {
  if (pickOrderUi.gameId !== d.gameId) {
    clearTimeout(pickOrderUi.timer);
    Object.assign(pickOrderUi, { gameId: d.gameId, order: null, pending: null, pendingKey: null, timer: null, hoverSignature: null });
  }
  const desired = suggested.map((r) => r.p.cellId);
  const canChange = Engine.shouldUpdatePickOrder(Boolean(pickOrderUi.order), d.turn)
    || Engine.shouldUpdatePickOrderForHover(d.turn, teammateHoverChanged);
  const improvement = Engine.pickOrderImprovement(pickOrderUi.order, desired, suggested);
  const result = Engine.stabilizePickOrder(pickOrderUi.order, pickOrderUi.pending, desired, Date.now(), PICK_ORDER_STABILITY_MS, canChange, improvement, PICK_ORDER_HYSTERESIS);
  pickOrderUi.order = result.order;
  pickOrderUi.pending = result.pending;
  const pendingKey = result.pending?.order.join(',') || null;
  if (pendingKey !== pickOrderUi.pendingKey) {
    clearTimeout(pickOrderUi.timer);
    pickOrderUi.timer = null;
    pickOrderUi.pendingKey = pendingKey;
    if (pendingKey) {
      const gameId = d.gameId;
      pickOrderUi.timer = setTimeout(() => {
        pickOrderUi.timer = null;
        if (pickOrderUi.gameId === gameId && screen === 'main') renderMain();
      }, PICK_ORDER_STABILITY_MS);
    }
  }
  const byCell = new Map(rated.map((r) => [r.p.cellId, r]));
  return pickOrderUi.order.map((cellId) => byCell.get(cellId)).filter(Boolean);
}

function pickOrderHtml(d, blocked) {
  const byCell = new Map(d.ally.map((p) => [p.cellId, p]));
  const remaining = (d.allyPickOrder || []).map((c) => byCell.get(c)).filter((p) => p && !p.locked && p.position);
  if (remaining.length < 2) return '';
  if (pickOrderUi.gameId !== d.gameId) {
    clearTimeout(pickOrderUi.timer);
    Object.assign(pickOrderUi, { gameId: d.gameId, order: null, pending: null, pendingKey: null, timer: null, hoverSignature: null });
  }
  const hoverSignature = remaining.filter((p) => !p.isLocal).map((p) => `${p.cellId}:${p.hoverId || 0}`).join(',');
  const teammateHoverChanged = pickOrderUi.hoverSignature !== null && pickOrderUi.hoverSignature !== hoverSignature;
  pickOrderUi.hoverSignature = hoverSignature;
  const nameOf = (p) => (p.isLocal ? S.me?.nickname : memberByPuuid(p.puuid)?.nickname) || ROLE_NAME[p.position];
  const rated = remaining.map((p) => {
    const championId = !p.isLocal && p.hoverId ? p.hoverId : 0;
    const playerId = p.isLocal ? S.me?.id : memberByPuuid(p.puuid)?.id;
    const ev = championId
      ? Engine.evaluate({ stats: S.stats, model: S.model, championId, role: p.position, ...draftContext(d, p.cellId), lookAhead: true, unavailable: blocked, personal: personalOf(playerId, d) })
      : null;
    return { p, championId, risk: ev?.counterRisk ?? 0, matchup: ev?.matchup ?? 0, personal: ev?.personal ?? 0, poolDepth: poolDepthOf(playerId, p.position) };
  });
  const enemyPicks = d.enemy.filter((p) => p.locked && p.championId);
  const suggested = stabilizedPickOrder(d, rated, Engine.orderPickSuggestions(rated, enemyPicks, S.model, draftContext(d).allies), teammateHoverChanged);
  const trades = Engine.pickOrderTrades(rated, suggested, d.allyPickGroups || []);
  const riskText = (n) => (n > 0 ? `<b class="down">−${n}</b>` : n < 0 ? `<b class="up">+${-n}</b>` : '<b>0</b>');
  return `
    <div class="pick-order">
      <h3 class="sub" title="By role; a teammate's hovered champion also counts. Nobody's usual champion is assumed">Pick Order</h3>
      <ol>${suggested.map((r) => `<li>${r.championId ? champImg(r.championId, 's') : ''}<span><b>${esc(nameOf(r.p))}</b><small>${ROLE_NAME[r.p.position]}</small></span><span class="risk" title="Counter risk shown; order also saves solo lanes for CT opportunities">${riskText(r.risk)}</span></li>`).join('')}</ol>
      ${trades.slice(0, 2).map(([a, b]) => `<p class="trade">Trade: <b>${esc(nameOf(a))}</b> ↔ <b>${esc(nameOf(b))}</b></p>`).join('')}
    </div>`;
}

// The game plan once every champion is locked (it stays through the game). Every number is
// the model's, in percentage points of win chance, so they can be compared; the advice is
// read off the same numbers with the same threshold (plan.edge), so it never says
// something the numbers do not show.
const signedPct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;
const pctClass = (v, edge) => (v >= edge ? 'up' : v <= -edge ? 'down' : '');
const PLAN_PARTS = [
  ['champions', 'Champions', 'Strength of each pick in its role'],
  ['synergy', 'Synergy', 'Pairs on the same team, both teams'],
  ['matchups', 'Matchups', 'Every champion against every enemy'],
  ['composition', 'Composition', 'Team styles and how they meet'],
];

function gamePlanHtml(d) {
  const allies = d.ally.filter((p) => p.locked && p.championId).map((p) => ({ championId: p.championId, position: p.position }));
  const enemies = d.enemy.filter((p) => p.locked && p.championId).map((p) => ({ championId: p.championId, position: p.position }));
  if (allies.length < 5 || enemies.length < 5) return '';
  const plan = Engine.gamePlan({ model: S.model, allies, enemies, damage: S.damage });
  if (!plan) return '';
  const E = plan.edge;
  // Bars from the middle: right for us, left for them; full width at the largest value (at least 5 points)
  const values = [...Object.values(plan.parts), ...plan.lanes.filter(Boolean).map((l) => l.pct), plan.early, plan.later, plan.objectives];
  const scale = Math.max(5, ...values.map(Math.abs));
  const bar = (v) => `<span class="pbar"><i class="${v < 0 ? 'neg' : 'pos'} ${pctClass(v, E)}" data-w="${Math.min(50, (Math.abs(v) / scale) * 50)}"></i></span>`;
  const row = (label, v, title = '', extra = '') => `<div class="prow"${title ? ` title="${esc(title)}"` : ''}><span class="plabel">${label}</span>${extra}${bar(v)}<b class="pval ${pctClass(v, E)}">${signedPct(v)}</b></div>`;
  const call = { ahead: 'Ahead', even: 'Even', behind: 'Behind' };
  const lanes = plan.lanes.filter(Boolean).map((l) => row(
    ROLE_NAME[l.role],
    l.pct,
    l.games ? `${champName(l.ours)} vs ${champName(l.theirs)}: learned from ${l.games} games of this lane` : `${champName(l.ours)} vs ${champName(l.theirs)}: from both champions' average lanes`,
    `<span class="pvs">${champImg(l.ours, 's')}${champImg(l.theirs, 's')}</span><small class="pcall ${l.call}">${call[l.call]}</small>`,
  )).join('');
  const chance = Math.round(plan.winChance * 100);
  return `
    <div class="game-plan">
      <h3 class="sub head-row"><span>Game Plan</span><span class="hint">Draft win chance <b class="${pctClass(chance - 50, E)}">${chance}%</b></span></h3>
      <div class="plan-grid">
        <div class="plan-block"><small>Where the edge comes from</small>${PLAN_PARTS.map(([k, label, title]) => row(label, plan.parts[k], title)).join('')}</div>
        <div class="plan-block"><small>By phase</small>
          ${row('Early', plan.early, 'Lanes and first objectives together: the first 15 minutes')}
          ${row('Later', plan.later, 'The rest of the draft\'s edge: teamfights, scaling, the game after laning')}
          ${row('Objectives', plan.objectives, 'First blood, tower, dragon, herald and grubs')}
        </div>
        <div class="plan-block lanes-block"><small>Lanes · laning phase</small>${lanes}</div>
      </div>
    </div>`;
}

// Runes, items and spells for our pick, once every champion is locked; sent to the client
// on their own when the options say so, else with the Apply buttons
const BUCKET_TEXT = { any: 'General', ap: 'vs Magic Damage', ad: 'vs Physical Damage', mixed: 'vs Mixed Damage' };
function buildHtml() {
  const pick = S.currentBuild;
  if (!pick) return '<div class="build"><h3 class="sub">Build</h3><p class="note">Waiting for all picks.</p></div>';
  const { build } = pick;
  const perks = S.gameData?.perks || {};
  const spells = S.gameData?.summoner || {};
  const perkImg = (id) => (perks[id] ? `<img src="https://ddragon.leagueoflegends.com/cdn/img/${perks[id].icon}" alt="" title="${esc(perks[id].name)}">` : '');
  const itemImg = (id, title) => `<img src="https://ddragon.leagueoflegends.com/cdn/${S.patch}/img/item/${id}.png" alt="" title="${esc(title || S.gameData?.items?.[id] || '')}">`;
  const pathHtml = (steps) => (steps?.length ? `<span class="item-group item-path"><small>Build Order</small><span>${steps.map((s) => `<span class="step">${s.parts.map((p) => `<span class="part">${itemImg(p)}</span>`).join('')}${s.parts.length ? '<i>→</i>' : ''}${itemImg(s.id)}</span>`).join('')}</span></span>` : '');
  const spellImg = (id) => (spells[id] ? `<img src="https://ddragon.leagueoflegends.com/cdn/${S.patch}/img/spell/${spells[id].image}" alt="" title="${esc(spells[id].name)}">` : '');
  const applied = S.applied?.gameId === S.draft?.gameId ? S.applied.parts || {} : {};
  const state = (part) => (applied[part] === true ? '<span class="ok">Applied</span>' : applied[part] === false ? '<span class="fail">Failed</span>' : '');
  const keystone = build.runes.perks[0];
  const group = (label, ids, title) => (ids?.length ? `<span class="item-group"><small>${label}</small><span>${ids.map((id) => itemImg(id, title?.(id))).join('')}</span></span>` : '');
  const situational = pick.situational || [];
  const why = new Map(situational.map((x) => [x.id, `+${(x.value * 100).toFixed(1)}% win chance vs ${x.reasons.join(', ')}`]));
  return `
    <div class="build">
      <h3 class="sub head-row"><span>Build · ${BUCKET_TEXT[pick.bucket] || ''}</span><span class="hint">${build.games} games</span></h3>
      <div class="build-row">
        <div class="build-part runes">${perkImg(keystone)}<span>${esc(perks[keystone]?.name || '')}<small>${esc(perks[build.runes.primary]?.name || '')} · ${esc(perks[build.runes.sub]?.name || '')}</small></span>${state('runes')}<button class="btn ghost" data-apply="runes">Apply Runes</button></div>
        <div class="build-part items">
          ${group('Starting Items', build.items.start)}
          ${build.items.path?.length ? pathHtml(build.items.path) : `${group('Core', build.items.core)}${group('Boots', build.items.boots ? [build.items.boots] : [])}`}
          ${group('Situational', situational.map((x) => x.id), (id) => why.get(id))}
          ${state('items')}<button class="btn ghost" data-apply="items">Apply Items</button>
        </div>
        <div class="build-part spells">${build.spells.map(spellImg).join('')}${state('spells')}<button class="btn ghost" data-apply="spells">Apply Spells</button></div>
      </div>
      ${situational.length ? `<p class="note sit-note">${situational.map((x) => `<b>${esc(S.gameData?.items?.[x.id] || '')}</b>${S.gameData?.items?.[x.id] ? ' ' : ''}vs ${esc(x.reasons.join(', '))}`).join(' · ')}</p>` : ''}
    </div>`;
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
    personal: isAlly ? personalOf(p.isLocal ? S.me?.id : memberByPuuid(p.puuid)?.id, d) : null,
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

// The game that just ended: what the draft promised next to what happened
function lastGameHtml(g) {
  if (!g?.draft) return '';
  const d = withRoles(g.draft);
  const order = (p) => ROLES.findIndex(([r]) => r === p.position);
  const team = (list) => list.filter((p) => p.championId).map((p) => ({ championId: p.championId, position: p.position })).sort((a, b) => order(a) - order(b));
  const allies = team(d.ally);
  const enemies = team(d.enemy);
  const plan = allies.length === 5 && enemies.length === 5 ? Engine.gamePlan({ model: S.model, allies, enemies, damage: S.damage }) : null;
  const scoreOf = (p, own, other) => Engine.evaluate({ stats: S.stats, model: S.model, championId: p.championId, role: p.position, allies: own.filter((x) => x !== p), enemies: other })?.score ?? null;
  const stats = new Map(g.players.map((p) => [`${p.side}:${p.championId}`, p]));
  const rows = (list, other, side) => list.map((p) => {
    const st = stats.get(`${side}:${p.championId}`) || {};
    const sc = scoreOf(p, list, other);
    return `<div class="lg-row">${champImg(p.championId, 's')}<span class="lg-role">${ROLE_NAME[p.position] || ''}</span>${sc === null ? '<span></span>' : `<b class="sc sc-${tierOf(sc)}">${sc}</b>`}<span>${st.kills ?? '–'}/${st.deaths ?? '–'}/${st.assists ?? '–'}</span><span>${st.cs ?? '–'} cs</span><span>${st.damage != null ? `${(st.damage / 1000).toFixed(1)}k` : '–'}</span></div>`;
  }).join('');
  const avg = (list, other) => {
    const v = list.map((p) => scoreOf(p, list, other)).filter((x) => x !== null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const ourAvg = avg(allies, enemies);
  const theirAvg = avg(enemies, allies);
  const chance = plan ? Math.round(plan.winChance * 100) : null;
  const call = { ahead: 'ahead', even: 'even', behind: 'behind' };
  const lanes = plan ? plan.lanes.filter(Boolean).map((l) => `${ROLE_NAME[l.role]} ${call[l.call]} (${signedPct(l.pct)})`).join(' · ') : '';
  return `
    <div class="last-game">
      <div class="lg-head">
        <h2>Last Game: <span class="${g.win ? 'win' : 'loss'}">${g.win ? 'Win' : g.win === false ? 'Loss' : ''}</span></h2>
        <span class="muted">${g.durationS ? `${Math.floor(g.durationS / 60)}:${String(g.durationS % 60).padStart(2, '0')}` : ''}</span>
        ${chance !== null ? `<span class="lg-chance">Draft win chance <b>${chance}%</b></span>` : ''}
      </div>
      <div class="lg-teams">
        <div><h3 class="sub">Your Team ${ourAvg !== null ? `<b class="sc sc-${tierOf(ourAvg)}">${ourAvg}</b>` : ''}</h3>${rows(allies, enemies, 'ally')}</div>
        <div><h3 class="sub">Enemy Team ${theirAvg !== null ? `<b class="sc sc-${tierOf(theirAvg)}">${theirAvg}</b>` : ''}</h3>${rows(enemies, allies, 'enemy')}</div>
      </div>
      ${lanes ? `<p class="note">Lanes the draft gave you: ${lanes}</p>` : ''}
    </div>`;
}

// ---------- Lineup roles (lobby / queue) ----------
// When all five in the party are team members: who should play which role, from the
// statistics of the Champions tab (season, patch, and the games with exactly these five)
function lineupRolesHtml() {
  const lobby = S.lobby;
  if (!lobby || lobby.members.length !== 5 || !S.model) return '';
  const people = lobby.members.map((m) => {
    const member = (m.isLocal && S.me) || memberByPuuid(m.puuid);
    return member ? { id: member.id, roles: member.roles || [], preferences: m.preferences } : null;
  });
  if (people.some((p) => !p) || new Set(people.map((p) => p.id)).size !== 5) return '';
  const result = Engine.lineupRoles({ model: S.model, members: people, playerStats: S.playerStats });
  if (!result) return '';
  const [best, ...others] = result.options;
  const signed = (n) => `<b class="${n > 0 ? 'up' : n < 0 ? 'down' : ''}">${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}</b>`;
  const label = { season: 'Season', history: 'Patch', team: 'With team' };
  const order = (option) => [...option.picks].sort((a, b) => ROLES.findIndex(([r]) => r === a.role) - ROLES.findIndex(([r]) => r === b.role));
  const row = (p) => `
    <div class="lr-row">
      <span class="lr-role">${roleIcon(p.role)}${esc(ROLE_NAME[p.role])}</span>
      <span class="lr-who"><b>${esc(nickOf(p.id))}</b><small>${Object.entries(p.parts).map(([k, v]) => `${label[k]} ${v.games}g`).join(' · ') || 'No games yet'}</small></span>
      <span class="lr-champs">${p.champions.map((c) => champImg(c, 's')).join('')}</span>
      ${signed(p.points)}
    </div>`;
  const close = result.margin < 3;
  return `
    <div class="lineup-roles">
      <h3>Suggested Roles <small>${close ? 'close call' : 'for this five'}</small></h3>
      ${order(best).map(row).join('')}
      ${others.length ? `<details><summary>Other options</summary>${others.map((o) => `
        <div class="lr-alt">${order(o).map((p) => `<span>${esc(ROLE_NAME[p.role])}: ${esc(nickOf(p.id))}</span>`).join('')}<b class="down">${o.total - best.total}</b></div>`).join('')}</details>` : ''}
    </div>`;
}

// ---------- Comp: what each team is turning into ----------
const classOf = (championId) => champMap().get(championId)?.tags?.[0] || S.model?.tags?.[championId] || 'None';
function compCard(title, ids, mine) {
  const comp = Traits.compProfile(ids.map((id) => ({ id, tag: classOf(id) })));
  const sure = Math.round(comp.confidence * 100);
  const plans = comp.plans.map((p) => `
    <div class="plan ${comp.plan === p.key && !comp.mixed ? 'lead' : ''}" title="${esc(p.name)}">
      <span>${esc(p.name)}</span><div class="plan-track"><i data-w="${Math.round(p.share * 100)}"></i></div><b>${Math.round(p.share * 100)}%</b>
    </div>`).join('');
  const chips = comp.needs.slice(0, 7).map((n) => `<span class="need ${n.state}" title="${esc(n.name)}: ${n.have} of about ${n.need}">${esc(n.name)} <b>${n.have}/${Math.ceil(n.need)}</b></span>`).join('');
  const open = comp.needs.filter((n) => n.state !== 'done').slice(0, 3).map((n) => n.name);
  const ap = Math.round(comp.damage.ap * 100);
  const dmgText = { open: '', balanced: 'Balanced damage', 'ap-heavy': 'Too much magic damage', 'ad-heavy': 'Too much physical damage' }[comp.damage.state];
  return `
    <div class="comp-card ${mine ? 'ours' : 'theirs'}">
      <div class="comp-head"><span class="comp-kicker">${title}</span><b>${esc(comp.label)}</b><small>${comp.plan ? `${sure}% sure · ` : ''}${comp.n}/5 picks</small></div>
      ${comp.n ? `<div class="plans">${plans}</div>` : ''}
      ${comp.n ? `<div class="needs">${chips}</div>` : ''}
      ${comp.n ? `<div class="dmg ${comp.damage.state}"><span>AD</span><div class="dmg-track"><i data-w="${ap}"></i></div><span>AP</span><small>${dmgText}</small></div>` : ''}
      ${mine && comp.n && comp.n < 5 && open.length ? `<p class="comp-next">Look for: <b>${esc(open.join(', '))}</b></p>` : ''}
    </div>`;
}
function compHtml(d) {
  const ours = d.ally.map(shownChamp).filter(Boolean);
  const theirs = d.enemy.map(shownChamp).filter(Boolean);
  if (!ours.length && !theirs.length) return '';
  return `<section class="comp" aria-label="Team compositions">${compCard('YOUR COMP', ours, true)}${compCard('ENEMY COMP', theirs, false)}</section>`;
}

function renderDraft() {
  clearInterval(timerHandle);
  const d = withRoles(S.draft);
  if (!d && S.lastGame?.draft) {
    $view.innerHTML = lastGameHtml(S.lastGame);
    return;
  }
  if (!d) {
    const connected = S.lcu?.connected;
    $view.innerHTML = `
      <div class="waiting ${connected ? 'on' : ''}">
        <div class="orb" aria-hidden="true">
          <span class="ring r1"></span><span class="ring r2"></span><span class="ring r3"></span>
          <span class="sweep"></span>
          <img class="orb-seal" src="logo.png" alt="">
        </div>
        <p class="kicker">${connected ? 'Eyes open' : 'The Rift is quiet'}</p>
        <h2 class="waiting-title">${connected ? 'Awaiting Champ Select' : 'Awaiting League'}</h2>
        <p class="waiting-text">${connected
          ? 'Queue up. The draft unfolds here the moment champ select begins.'
          : 'Open the client and Itachio awakens on its own.'}</p>
        <div class="scan"><span class="scan-dot"></span>${connected ? esc(PHASE_TEXT[S.lcu?.phase] || 'Idle') : 'Listening for the client'}</div>
        ${connected ? lineupRolesHtml() : ''}
        ${S.stats?.meta?.length ? '' : '<p class="waiting-text small">No meta data yet. Recommendations appear after the collector runs for the first time.</p>'}
      </div>`;
    return;
  }

  const blocked = unavailable(d);
  const turnText = !d.turn
    ? d.phase === 'FINALIZATION' ? 'Finalization' : PHASE_TEXT[S.lcu?.phase] || 'Waiting'
    : d.isOurTurn
      ? d.turn.kind === 'ban' ? 'Your Turn to Ban' : 'Your Turn to Pick'
      : `${d.turn.side === 'ally' ? 'Your Team Is' : 'Enemy Is'} ${d.turn.kind === 'ban' ? 'Banning' : 'Picking'}`;

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
        limit: 80,
        personal: personalOf(S.me?.id, d),
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
          <span>Ban Suggestions</span>
          ${bans.length ? '<span class="hint">Click to hover the ban in the client</span>' : ''}
        </h3>
        ${bans.length
          ? `<div class="recs" data-kind="ban">${bans.map((r, i) => banRow(r, i, { canHover: true, hoverId: d.banHoverId })).join('')}</div>`
          : '<p class="note">Ban suggestions need the learned model; they appear after the next training.</p>'}
      </div>`
    : '';

  // The build for our pick once every champion is locked (sent to the client automatically)
  const buildBlock = local?.locked ? buildHtml() + gamePlanHtml(d) : '';

  // After locking: your pick with its live breakdown
  let pickRow = '';
  if (local?.locked) {
    const ev = Engine.evaluate({ stats: S.stats, model: S.model, championId: local.championId, role, ...draftContext(d, local.cellId), personal: personalOf(S.me?.id, d) });
    if (ev) pickRow = `<div class="recs pinned">${recRow({ ...ev, inPool: false }, 0, { canHover: false, rank: '✓' })}</div>`;
  }

  // The champion you are hovering, if it is not already in the list
  let hoverRow = '';
  if (local && !local.locked && local.hoverId && !recs.some((r) => r.championId === local.hoverId)) {
    const ev = Engine.evaluate({
      stats: S.stats, model: S.model, championId: local.hoverId, role, ...draftContext(d, local.cellId),
      lookAhead: true, unavailable: blocked, personal: personalOf(S.me?.id, d),
    });
    if (ev) {
      const row = { ...ev, inPool: myPool().some((p) => p.champion_id === local.hoverId) };
      hoverRow = `<h3 class="sub gap">Your Hover</h3><div class="recs pinned">${recRow(row, 0, { canHover: false, hoverId: local.hoverId, rank: '•' })}</div>`;
    }
  }

  const explanationId = local?.locked ? local.championId : local?.hoverId || recs[0]?.championId;
  const explanation = explanationId ? Engine.evaluate({
    stats: S.stats, model: S.model, championId: explanationId, role,
    ...draftContext(d, local?.cellId), lookAhead: !local?.locked, unavailable: blocked,
    personal: personalOf(S.me?.id, d),
  }) : null;
  const explanationBlock = modelExplanation(explanation);
  const recommendationList = recs.length
    ? `${tierGrid(recs, { canHover: !!d.myPickActionId, hoverId: local?.hoverId })}${explanationBlock}${hoverRow}`
    : '';
  const recommendationContent = local?.locked
    ? pickRow + explanationBlock + buildBlock
    : recs.length
      ? recommendationList
      : `<p class="note">${hasStats
          ? 'No pickable champions left for this role.'
          : 'No meta data yet. Recommendations appear here after the collector runs.'}</p>`;

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
        ${compHtml(d)}
        ${pickOrderHtml(d, blocked)}
        <div>
          <h3 class="sub head-row">
            <span>${local?.locked ? `Your Pick: ${esc(champName(local.championId))}` : `Recommended${role ? ' · ' + ROLE_NAME[role] : ''}`}</span>
            ${!local?.locked && d.myPickActionId && recs.length ? '<span class="hint">Click to hover in the client</span>' : ''}
          </h3>
          ${recommendationContent}
        </div>
      </section>
      ${enemyCol}
    </div>`;

  // Inline style attributes are blocked by the CSP, so bar widths are set here
  for (const bar of $view.querySelectorAll('[data-w]')) bar.style.width = `${bar.dataset.w}%`;
  // Apply buttons of the build
  for (const b of $view.querySelectorAll('[data-apply]')) {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await run(api.applyBuild([b.dataset.apply]));
      } finally {
        b.disabled = false;
      }
    };
  }
  // Pick and ban lists: a click hovers the champion for that action in the client
  for (const list of $view.querySelectorAll('.recs')) {
    list.onclick = async (e) => {
      const b = e.target.closest('[data-hover]');
      if (!b || b.disabled) return;
      for (const x of list.querySelectorAll('.rec.hovering, .tile.hovering')) x.classList.remove('hovering');
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
        <h2>${isAlly ? 'Your Team' : 'Enemy Team'}</h2>
        ${avg === null ? '' : `<div class="avg" title="Average score of the champions shown"><small>avg</small><b class="sc sc-${tierOf(avg)}">${avg}</b></div>`}
        <span>${color === 'blue' ? 'Blue Side' : 'Red Side'}</span>
      </div>
      ${slots.join('')}
      <div class="bans">${bans.length ? bans.map((id) => champImg(id, 's')).join('') : '<span class="note">No bans</span>'}</div>
    </section>`;
}

// ---------- Champions ----------
// How each player does on each champion (collector/src/players), from three kinds of games:
// their ranked games of the season, those of the patch, and those with team members on
// their side (per line-up). Games, record, and the effect split into the laning phase and
// the rest of the game.
// Champions worth learning for a player: in each role they play (chosen in the Team tab,
// else the role they play most), the best scored with the champions their teammates
// usually play, leaving out what they already play there
const LEARN_COUNT = 5;
function learnHtml(playerId) {
  if (!S.model) return '';
  const entries = playedEntries(playerId);
  const member = (S.members || []).find((m) => m.id === playerId);
  let roles = (member?.roles || []).filter((r) => ROLE_NAME[r]);
  if (!roles.length) {
    const roleGames = {};
    for (const e of entries) roleGames[e.role] = (roleGames[e.role] || 0) + e.games;
    const main = Object.entries(roleGames).sort((a, b) => b[1] - a[1])[0]?.[0];
    roles = main ? [main] : [];
  }
  roles = ROLES.map(([r]) => r).filter((r) => roles.includes(r));
  const rows = roles.map((role) => {
    const played = new Set(entries.filter((e) => e.role === role).map((e) => e.championId));
    // Teammates' usual champion in each other role
    const allies = [];
    for (const m of S.members || []) {
      if (m.id === playerId) continue;
      const theirs = playedEntries(m.id)
        .filter((x) => x.role !== role && !allies.some((a) => a.position === x.role))
        .sort((a, b) => b.games - a.games)[0];
      if (theirs) allies.push({ championId: theirs.championId, position: theirs.role });
    }
    const picks = Engine.recommend({ stats: S.stats, model: S.model, role, allies, limit: 40 })
      .filter((r) => !played.has(r.championId))
      .slice(0, LEARN_COUNT);
    if (!picks.length) return '';
    return `
      <div class="learn-line">
        <span class="learn-role">${ROLE_NAME[role]}</span>
        <div class="learn-row">${picks.map((r) => `<span class="learn-pick">${champImg(r.championId)}<span>${esc(champName(r.championId))}</span><b class="sc sc-${tierOf(r.score)}">${r.score}</b></span>`).join('')}</div>
      </div>`;
  }).join('');
  if (!rows) return '';
  return `
    <div class="learn">
      <h3 class="sub">Champions to Learn</h3>
      ${rows}
    </div>`;
}

const nickOf = (id) => (S.members || []).find((m) => m.id === id)?.nickname || '?';
// A line-up's name from one player's side: the team members they played with
const lineupName = (lineup, playerId) => `with ${lineup.split(',').filter((id) => id !== playerId).map(nickOf).join(', ')}`;
const lineupCompact = (lineup, playerId) => {
  const others = lineup.split(',').filter((id) => id !== playerId).map(nickOf);
  if (others.length <= 2) return `with ${others.join(', ')}`;
  return `with ${others[0]}, ${others[1]} +${others.length - 2}`;
};
const lineupPeople = (lineup, playerId) => lineup.split(',').filter((id) => id !== playerId).map(nickOf);
const gamesOf = (stats) => Object.values(stats?.byKey || {}).reduce((a, v) => a + v.games, 0);
const recordOf = (stats) => {
  const games = gamesOf(stats);
  const wins = Object.values(stats?.byKey || {}).reduce((sum, value) => sum + value.wins, 0);
  return { games, wins, losses: games - wins, winRate: games ? Math.round((wins / games) * 100) : 0 };
};

let lineupPickerCleanup = null;
function renderLineupPicker(lineups, selected, playerId) {
  const selectedStats = lineups.find(([key]) => key === selected)?.[1];
  const record = recordOf(selectedStats);
  const avatars = (key) => lineupPeople(key, playerId).slice(0, 3).map((name, i) =>
    `<span class="lineup-avatar tone-${i}" title="${esc(name)}">${esc(name.slice(0, 1).toUpperCase())}</span>`,
  ).join('');
  return `
    <div class="lineup-picker" id="lineupPicker">
      <button type="button" class="lineup-trigger" id="lineupTrigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="lineupOptions" title="Choose a team lineup">
        <span class="lineup-seal" aria-hidden="true"><span></span><span></span><span></span></span>
        <span class="lineup-current-copy"><small>TEAM LINEUP</small><b>${esc(lineupCompact(selected, playerId))}</b></span>
        <span class="lineup-record"><b>${record.games}G</b><small>${record.wins}–${record.losses}</small></span>
        <span class="lineup-chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="lineup-options" id="lineupOptions" role="listbox" aria-label="Team lineups" hidden>
        <div class="lineup-options-head"><span>RECENT LINEUPS</span><span>${lineups.length} total</span></div>
        ${lineups.map(([key, stats]) => {
          const item = recordOf(stats);
          const active = key === selected;
          return `<button type="button" class="lineup-option ${active ? 'active' : ''}" role="option" aria-selected="${active}" data-lineup="${esc(key)}">
            <span class="lineup-avatars" aria-hidden="true">${avatars(key)}</span>
            <span class="lineup-option-copy"><b>${esc(lineupCompact(key, playerId))}</b><small>${esc(lineupName(key, playerId))}</small></span>
            <span class="lineup-option-record"><b>${item.games}G</b><small>${item.wins}–${item.losses} · ${item.winRate}%</small></span>
            <span class="lineup-check" aria-hidden="true">${active ? '✓' : ''}</span>
          </button>`;
        }).join('')}
      </div>
    </div>`;
}

function attachLineupPicker() {
  const root = document.getElementById('lineupPicker');
  if (!root) return;
  const trigger = root.querySelector('#lineupTrigger');
  const panel = root.querySelector('#lineupOptions');
  const options = [...panel.querySelectorAll('[role="option"]')];
  const setOpen = (open, focus = false) => {
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open && focus) (options.find((option) => option.getAttribute('aria-selected') === 'true') || options[0])?.focus();
  };
  const onOutside = (event) => { if (!root.contains(event.target)) setOpen(false); };
  trigger.onclick = () => setOpen(panel.hidden, panel.hidden);
  root.onkeydown = (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
      trigger.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (panel.hidden) return setOpen(true, true);
    const current = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? options.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  };
  for (const option of options) option.onclick = () => {
    statsUi.lineup = option.dataset.lineup;
    renderChampions();
  };
  document.addEventListener('pointerdown', onOutside);
  lineupPickerCleanup = () => document.removeEventListener('pointerdown', onOutside);
}

function renderChampions() {
  lineupPickerCleanup?.();
  lineupPickerCleanup = null;
  const members = S.members || [];
  const id = statsUi.player && members.some((m) => m.id === statsUi.player) ? statsUi.player : S.me?.id;
  const source = STAT_SOURCES.find(([k]) => k === statsUi.source) || STAT_SOURCES[0];
  const own = (S.playerStats || {})[id] || {};
  // With the team: one line-up at a time, the one with the most games first
  const lineups = Object.entries(own.team || {}).sort((a, b) => gamesOf(b[1]) - gamesOf(a[1]));
  const lineup = source[0] === 'team' ? (lineups.find(([k]) => k === statsUi.lineup) || lineups[0])?.[0] : null;
  const stats = source[0] === 'team' ? (lineup ? own.team[lineup] : null) : own[source[0]];
  const pts = (x) => Engine.points(S.model, x);
  const signed = (n) => `<b class="${n > 0 ? 'up' : n < 0 ? 'down' : ''}">${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}</b>`;
  const rows = stats
    ? Object.entries(stats.byKey)
        .map(([key, v]) => ({ championId: Number(key.split(':')[0]), role: key.split(':')[1], ...v }))
        .sort((x, y) => y.games - x.games || y.delta - x.delta)
    : [];
  const empty = {
    season: 'No ranked games this season yet.',
    history: 'No ranked games this patch yet.',
    team: 'No ranked games of five team members together yet. Games where all five on your side are team members count here, for each five.',
  }[source[0]];
  $view.innerHTML = `
    <div class="champ-stats">
      <div class="toolbar">
        <h2>Champion Statistics</h2>
        <div class="seg" id="src">${STAT_SOURCES.map(([k, label]) => `<button data-src="${k}" class="${k === source[0] ? 'active' : ''}">${label}</button>`).join('')}</div>
        <span class="grow"></span>
        <div class="toolbar-actions">
          ${lineups.length && source[0] === 'team' ? renderLineupPicker(lineups, lineup, id) : ''}
          <select id="who" class="who-select">${members.map((m) => `<option value="${m.id}" ${m.id === id ? 'selected' : ''}>${esc(m.nickname)}</option>`).join('')}</select>
        </div>
      </div>
      <p class="note source-note">${{
        season: 'How well each champion goes for this player, from all their ranked games of the season. It feeds their scores in the draft.',
        history: 'The same from this patch only: fewer games, but how each champion does for them right now. It feeds their scores too.',
        team: 'Their games where all five on their side were these team members. In the draft it counts when the same five are on your side.',
      }[source[0]]}</p>
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
        : `<p class="note">${empty}</p>`}
      ${learnHtml(id)}
    </div>`;
  document.getElementById('src').onclick = (e) => {
    const b = e.target.closest('[data-src]');
    if (!b) return;
    statsUi.source = b.dataset.src;
    renderMain();
  };
  document.getElementById('who').onchange = (e) => {
    statsUi.player = e.target.value;
    statsUi.lineup = null;
    renderChampions();
  };
  attachLineupPicker();
}

// ---------- Team ----------
function renderTeam() {
  const t = S.team;
  const isOwner = t?.owner_id === S.me?.id;
  $view.innerHTML = `
    <div class="team-head">
      <h2>${esc(t?.name || '')}</h2>
      <span class="muted">Invite code</span><span class="code">${esc(t?.join_code || '')}</span>
      <button class="btn ghost" id="copy">Copy Code</button>
      <span class="grow"></span>
      <button class="btn ghost" id="prof">Edit Profile</button>
      <button class="btn ghost" id="leave">Leave Team</button>
      <button class="btn ghost" id="out">Sign Out</button>
    </div>
    <div class="members">
      ${S.members.map((m) => {
        const owner = t?.owner_id === m.id;
        const mine = m.id === S.me?.id;
        const roles = new Set(m.roles || []);
        // Any number of roles: the team is not a fixed five, and a player can play several
        const chips = ROLES.map(([r, name]) => (mine
          ? `<button type="button" class="role-tile ${roles.has(r) ? 'on' : ''}" data-role="${r}" aria-pressed="${roles.has(r)}">${roleIcon(r)}<span>${name}</span></button>`
          : roles.has(r) ? `<span class="role-tag">${roleIcon(r)}${name}</span>` : '')).join('');
        return `
          <div class="member ${mine ? 'mine' : ''}">
            <div class="top">
              <span class="nick">${esc(m.nickname)}${owner ? ' <span class="badge owner">Owner</span>' : ''}</span>
            </div>
            <div class="muted small">${m.riot_id ? esc(m.riot_id) : 'LoL account not linked yet'}</div>
            ${mine ? `<div class="roles-label">Your roles <small>pick any number</small></div><div class="role-tiles">${chips}</div>` : `<div class="role-tags">${chips || '<span class="muted small">No roles chosen</span>'}</div>`}
            ${isOwner && m.id !== S.me.id ? `<button class="link kick" data-kick="${m.id}" data-name="${esc(m.nickname)}">Remove From Team</button>` : ''}
          </div>`;
      }).join('')}
    </div>`;
  $view.querySelector('.members').onclick = async (e) => {
    const chip = e.target.closest('[data-role]');
    if (chip) {
      const roles = new Set(S.me?.roles || []);
      if (roles.has(chip.dataset.role)) roles.delete(chip.dataset.role);
      else roles.add(chip.dataset.role);
      chip.disabled = true;
      S = await run(api.saveRoles(ROLES.map(([r]) => r).filter((r) => roles.has(r))));
      return renderMain();
    }
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
  document.getElementById('leave').onclick = async () => {
    if (!confirm('Are you sure you want to leave the team?')) return;
    S = await run(api.leaveTeam());
    decideScreen();
  };
}

// ---------- History ----------
// A player's ranked games of the season from Riot (the collector reads them), newest first:
// both teams in role order with every champion's score on the final board. Only for
// looking back; the champion statistics are in the Champions tab.
const QUEUE_NAME = { 420: 'Solo/Duo', 440: 'Flex' };
async function renderHistory(more = false) {
  const members = S.members || [];
  const id = historyUi.player && members.some((m) => m.id === historyUi.player) ? historyUi.player : S.me?.id;
  const mine = id === S.me?.id;
  if (!more) {
    $view.innerHTML = '<p class="note">Loading…</p>';
    historyUi.rows = [];
    historyUi.html = new Map();
  }
  // One more than shown tells whether there is another page
  const page = await run(api.listHistory(id, more ? historyUi.rows.length : 0, HISTORY_PAGE + 1));
  if (tab !== 'history') return;
  historyUi.more = page.length > HISTORY_PAGE;
  historyUi.rows = [...historyUi.rows, ...page.slice(0, HISTORY_PAGE)];
  const rows = historyUi.rows;
  const keepScroll = $view.scrollTop;
  const roleList = ROLES.map(([r]) => r);
  const team = (ids) => ids.map((championId, i) => ({ championId, position: roleList[i] }));
  // Every champion scored on the final board, from its own team's side, and the team's average
  const scored = (list, other) => {
    const picks = list.map((p) => {
      const ev = Engine.evaluate({ stats: S.stats, model: S.model, championId: p.championId, role: p.position, allies: list.filter((x) => x !== p), enemies: other });
      return { ...p, score: ev ? ev.score : null };
    });
    const known = picks.filter((p) => p.score !== null);
    return { picks, avg: known.length ? Math.round(known.reduce((a, p) => a + p.score, 0) / known.length) : null };
  };
  const teamHtml = (t, own) => `<div class="hteam">${t.picks.map((p) => `
      <span class="hpick ${p.championId === own ? 'own' : ''}">${champImg(p.championId, 's')}${p.score === null ? '<b></b>' : `<b class="sc sc-${tierOf(p.score)}">${p.score}</b>`}</span>`).join('')}</div>`;
  const avgHtml = (t) => (t.avg === null ? '<span class="havg"></span>' : `<span class="havg sc sc-${tierOf(t.avg)}">${t.avg}</span>`);
  const toolbar = `
    <div class="toolbar hist-bar">
      <h2>Ranked Games</h2>
      <span class="grow"></span>
      <select id="hwho">${members.map((m) => `<option value="${m.id}" ${m.id === id ? 'selected' : ''}>${esc(m.nickname)}</option>`).join('')}</select>
      ${mine && rows.length ? '<button class="btn ghost danger" id="hclear">Clear History</button>' : ''}
    </div>`;
  const body = rows.length
    ? `<div class="hist">${rows.map((r) => {
        const cached = historyUi.html.get(r.match_id);
        if (cached) return cached;
        const ours = r.side === 'red' ? r.red : r.blue;
        const theirs = r.side === 'red' ? r.blue : r.red;
        const us = scored(team(ours), team(theirs));
        const them = scored(team(theirs), team(ours));
        const kda = r.kills === null ? '' : `${r.kills}/${r.deaths}/${r.assists}`;
        const time = r.duration_s ? `${Math.floor(r.duration_s / 60)}:${String(r.duration_s % 60).padStart(2, '0')}` : '';
        const html = `
        <div class="hrow ${r.win ? 'won' : 'lost'}">
          <span class="hwhen"><b>${new Date(r.started_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</b><small>${QUEUE_NAME[r.queue_id] || ''}${time ? ` · ${time}` : ''}</small></span>
          <span class="hres ${r.win ? 'win' : 'loss'}">${r.win ? 'Win' : 'Loss'}<small class="tag ${r.side}">${r.side === 'red' ? 'Red' : 'Blue'}</small></span>
          <span class="hme">${champImg(r.champion_id)}<span><b>${esc(champName(r.champion_id))}</b><small>${ROLE_NAME[r.role] || ''}${kda ? ` · ${kda}` : ''}${r.cs !== null ? ` · ${r.cs} cs` : ''}</small>${r.lineup ? `<small class="hwith">${esc(lineupName(r.lineup, id))}</small>` : ''}</span></span>
          ${teamHtml(us, r.champion_id)}
          <div class="hscore">${avgHtml(us)}<span class="hvs">vs</span>${avgHtml(them)}</div>
          ${teamHtml(them, null)}
        </div>`;
        historyUi.html.set(r.match_id, html);
        return html;
      }).join('')}</div>${historyUi.more ? '<div class="hist-more"><button class="btn ghost" id="hmore">Load More</button></div>' : ''}`
    : `<div class="empty-state"><h2>No Games Yet</h2><p>${mine ? 'Your ranked games of the season show up here once the collector reads them from Riot.' : 'No ranked games to show.'}</p></div>`;
  $view.innerHTML = toolbar + body;
  $view.scrollTop = keepScroll;
  const moreBtn = document.getElementById('hmore');
  if (moreBtn) {
    moreBtn.onclick = () => {
      moreBtn.disabled = true;
      moreBtn.textContent = 'Loading…';
      renderHistory(true);
    };
  }
  document.getElementById('hwho').onchange = (e) => {
    historyUi.player = e.target.value;
    renderHistory();
  };
  const clear = document.getElementById('hclear');
  if (clear) {
    clear.onclick = async () => {
      if (!confirm('Clear your history? Games so far are hidden from this list. Champion statistics stay as they are.')) return;
      S = await run(api.clearHistory());
      toast('History cleared');
      renderHistory();
    };
  }
}

// ---------- Options ----------
// Kept on this computer. Essentials: start with Windows. Draft rites: send runes (with
// summoner spells) and the item build to the client once every champion is locked.
const OPTION_TABS = [
  ['general', 'Essentials', 'seal', [['openAtLogin', 'Awaken at sign-in', 'Ready before League opens']]],
  ['drafting', 'Draft Rites', 'scroll', [
    ['autoRunes', 'Rune seal', 'Sets runes and spells at lock-in'],
    ['autoItems', 'Item scroll', 'Sets the item build at lock-in'],
  ]],
];
ICONS.seal = '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 8 5.5M12 21a9 9 0 0 1-8-5.5M3.5 9.5A9 9 0 0 1 12 3"/><circle cx="12" cy="12" r="2.4"/>';
ICONS.scroll = '<path d="M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 0 2 2H9a2 2 0 0 1-2-2z"/><path d="M7 4a2 2 0 0 0-2 2v2h2M10 9h6M10 13h6"/>';
let optionsTab = 'general';
async function openOptions() {
  const settings = await run(api.getSettings());
  const $m = document.getElementById('modal');
  const close = () => ($m.innerHTML = '');
  const flip = async (toggle) => {
    if (toggle.disabled) return;
    const key = toggle.dataset.key;
    const wanted = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(wanted));
    toggle.disabled = true;
    try {
      const res = await api.setSettings({ [key]: wanted });
      if (!res?.ok) throw new Error(res?.error || 'Could not save');
      Object.assign(settings, res.data);
      toggle.setAttribute('aria-checked', String(!!settings[key]));
    } catch (e) {
      toggle.setAttribute('aria-checked', String(!wanted));
      toast(e.message, 'error');
    } finally {
      toggle.disabled = false;
    }
  };
  const draw = () => {
    const [, title, , items] = OPTION_TABS.find(([k]) => k === optionsTab);
    $m.innerHTML = `
      <div class="modal-overlay" id="mclose-bg">
        <div class="options" role="dialog" aria-modal="true" aria-label="Options">
          <nav class="options-nav">
            <div class="options-brand"><img class="seal" src="logo.png" alt=""><h2>Options</h2></div>
            ${OPTION_TABS.map(([k, label, ic]) => `
              <button type="button" data-otab="${k}" class="${k === optionsTab ? 'active' : ''}">${icon(ic)}${label}</button>`).join('')}
          </nav>
          <section class="options-body">
            <div class="options-head"><div><span class="page-kicker">OPTIONS</span><h3>${title}</h3></div><button type="button" class="x" id="mclose" aria-label="Close">\u00d7</button></div>
            ${items.map(([key, label, text]) => `
              <div class="option" data-row="${key}">
                <svg class="option-mark" viewBox="-12 -12 24 24" aria-hidden="true"><circle r="11" class="tomoe-ring"/><use href="#tomoe"/><use href="#tomoe" transform="rotate(120)"/><use href="#tomoe" transform="rotate(240)"/></svg>
                <span class="option-copy"><b>${label}</b><small>${text}</small></span>
                <button type="button" role="switch" class="toggle" data-key="${key}" aria-checked="${!!settings[key]}" aria-label="${label}"><i></i></button>
              </div>`).join('')}
          </section>
        </div>
      </div>`;
  };
  $m.onclick = (e) => {
    if (e.target.id === 'mclose-bg' || e.target.closest('#mclose')) return close();
    const tabBtn = e.target.closest('[data-otab]');
    if (tabBtn) {
      optionsTab = tabBtn.dataset.otab;
      return draw();
    }
    const row = e.target.closest('[data-row]');
    if (row) flip(row.querySelector('.toggle'));
  };
  draw();
}
document.getElementById('optbtn').onclick = openOptions;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.getElementById('modal').innerHTML = '';
});

boot();
