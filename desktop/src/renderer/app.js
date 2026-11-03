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
const roleGlyph = (r, title = ROLE_NAME[r] || '') => `<span class="role-gl" title="${esc(title)}" role="img" aria-label="${esc(title)}">${roleIcon(r)}</span>`;

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
const statsUi = { player: null, source: 'season', lineup: null, sort: 'delta', descending: true };
const STAT_SOURCES = [
  ['season', 'Season'], // the player's ranked games of the season
  ['history', 'Patch'], // the same, of the current patch
  ['team', 'Lineup'], // their games with five team members on their side, per line-up
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
  if (roleSave.want && S.me) applyLocalRoles(roleSave.want);
  if (screen !== 'main') return;
  if (tab === 'draft' && ['draft', 'pools', 'lcu', 'lobby', 'teamHistory', 'members', 'model', 'currentBuild', 'applied', 'gameData', 'lastGame'].some((k) => k in partial)) renderMain();
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
// Every glyph of the draft screen: no words, the meaning is in the tooltip
Object.assign(ICONS, {
  strength: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  synergy: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
  matchup: '<path d="M4 4l11 11M20 4L9 15M14 18l4-4M6 14l4 4M5 19l2-2M19 19l-2-2"/>',
  balance: '<path d="M12 4v16M8 20h8M5 7h14"/><path d="M5 7l-2.5 6a3 3 0 0 0 5 0zM19 7l-2.5 6a3 3 0 0 0 5 0z"/>',
  guard: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/>',
  flag: '<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>',
  focus: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
  lane: '<path d="M4 20L20 4M4 14l6 6M14 4l6 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  dots: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  star: '<path d="M12 3l2.8 5.9 6.2.9-4.5 4.4 1 6.3-5.5-3-5.5 3 1-6.3L3 9.8l6.2-.9z"/>',
  hex: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z"/>',
  objective: '<path d="M12 3l9 9-9 9-9-9z"/><path d="M12 8v8"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/>',
  pick: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  swap: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  apply: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  bag: '<path d="M6 8h12l1 12H5zM9 8a3 3 0 0 1 6 0"/>',
  gem: '<path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18"/>',
  route: '<path d="M4 18h5a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h8"/><path d="M13 3l3 3-3 3"/>',
  boot: '<path d="M8 3v9l-4 4v4h16v-3l-6-3V3z"/>',
  shuffle: '<path d="M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3M18 14l3 3-3 3"/>',
  sword: '<path d="M20 4l-9 9-3-1-3 3 2 2-3 3M20 4l-1 5-6 6M20 4l-5 1-6 6"/>',
  wand: '<path d="M4 20L15 9M15 4v2M20 9h-2M18.5 5.5L17 7M20 14l-1-1M10 5l1 1"/>',
  pk: '<circle cx="12" cy="12" r="7"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/>',
  en: '<path d="M3 12h13M11 6l6 6-6 6M20 5v14"/>',
  pe: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/><path d="M12 8v7M8.5 11.5h7"/>',
  pi: '<path d="M15 4v8a5 5 0 1 1-10 0v-1l3 3"/><circle cx="15" cy="3" r="1"/>',
  sp: '<path d="M12 21v-8M12 13L5 6M12 13l7-7M5 11V6h5M19 11V6h-5"/>',
  fr: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/>',
  cc: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  wc: '<path d="M3 9c3-3 6-3 9 0s6 3 9 0M3 15c3-3 6-3 9 0s6 3 9 0"/>',
  ac: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/><circle cx="12" cy="12" r="3"/>',
  sc: '<path d="M4 18l6-6 4 3 6-8M15 7h5v5"/>',
});
Object.assign(ICONS, {
  pool: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><path d="M14 17l2.5 2.5L21 14"/>',
  all: '<circle cx="6" cy="6" r="1.6"/><circle cx="12" cy="6" r="1.6"/><circle cx="18" cy="6" r="1.6"/><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/><circle cx="6" cy="18" r="1.6"/><circle cx="12" cy="18" r="1.6"/><circle cx="18" cy="18" r="1.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
});
const glyph = (name, title) => `<span class="gl" title="${esc(title)}" role="img" aria-label="${esc(title)}">${icon(name)}</span>`;
// The three statistics sources are inputs of the scores: each has its own entry
const MENU = [
  { id: 'draft', title: 'Draft', items: [
    { tab: 'draft', label: 'Draft Assistant', icon: 'target' },
    { tab: 'pool', label: 'Champion Pool', icon: 'pool' },
  ] },
  { id: 'players', title: 'Statistics', items: [
    { tab: 'champions', src: 'season', label: 'Season Stats', icon: 'calendar' },
    { tab: 'champions', src: 'history', label: 'Patch Stats', icon: 'layers' },
    { tab: 'champions', src: 'team', label: 'Lineup Stats', icon: 'users' },
    { tab: 'history', label: 'Match History', icon: 'clock' },
  ] },
  { id: 'team', title: 'Team', items: [{ tab: 'team', label: 'Roster', icon: 'shield' }] },
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
  if (screen === 'loading') $view.innerHTML = splashHtml('Loading team data and model…');
  if (screen === 'config') renderConfig();
  if (screen === 'login') renderLogin();
  if (screen === 'profile') renderProfile();
  if (screen === 'team') renderTeamSetup();
  if (screen === 'main') renderMain();
}

function renderStatus() {
  const warning = document.getElementById('metasrc-warning');
  warning.hidden = screen !== 'main' || !S?.metaSrcHealth?.stale;
  warning.textContent = 'MetaSRC data older than 72 hours';
  const l = S?.lcu;
  if (!l) return ($status.innerHTML = '');
  const acct = l.summoner?.riotId ? ` · ${esc(l.summoner.riotId)}` : '';
  $status.innerHTML = l.connected
    ? `<span class="dot on"></span><span><b>Client connected</b><small>${esc(PHASE_TEXT[l.phase] || l.phase)}${acct}</small></span>`
    : `<span class="dot"></span><span><b>Client offline</b><small>Start League of Legends</small></span>`;
}

function renderConfig() {
  $view.innerHTML = `
    <div class="card">
      <h2>Configuration Missing</h2>
      <p>${esc(configError)}</p>
      <p>Copy <b>config.example.json</b> to <b>config.json</b> in the app folder,
      set the Supabase project URL and key, then restart.</p>
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
      <p>Display name shown to team members. The Riot account links automatically while the client is running.</p>
      <label>Display name <input name="nickname" required minlength="2" maxlength="32" value="${esc(me?.nickname || S?.lcu?.summoner?.riotId?.split('#')[0] || '')}"></label>
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
      <h2>Team Setup</h2>
      <p>Join with an 8-character invite code.</p>
      <form class="row" id="join"><input name="code" placeholder="Invite code" required class="grow upper"><button class="btn primary">Join Team</button></form>
      <p class="gap">Or create a team and share its invite code.</p>
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
  // Section name in kanji, page name in English
  const pages = {
    draft: ['ドラフト', 'Draft Assistant'],
    champions: ['統計', `Champion Stats · ${sourceName}`],
    team: ['編成', 'Roster'],
    history: ['戦績', 'Match History'],
    pool: ['候補', 'Champion Pool'],
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
  if (tab === 'pool') renderPool();
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
    <button type="button" class="rec ${hovering ? 'hovering' : ''} ${r.unsure ? 'unsure' : ''}" data-hover="${r.championId}" title="${esc(champName(r.championId))}"
      ${canHover ? '' : 'disabled'}>
      <span class="rank">${rank ?? i + 1}</span>
      ${champImg(r.championId)}
      <span class="info"><span class="name">${esc(champName(r.championId))}</span></span>
      <span class="score"><b class="sc sc-${tier}">${r.score}</b><i class="bar-${tier}" data-w="${r.score}"></i></span>
    </button>`;
}
// Recommendations as tiers of champion tiles, each with its score
const TIER_BANDS = [['S+', 85], ['S', 75], ['A', 65], ['B', 55], ['C', 45], ['D', 0]];
function tierGrid(recs, { canHover, hoverId }) {
  const groups = TIER_BANDS.map(([label, min]) => ({ label, min, rows: [] }));
  for (const r of recs) groups.find((g) => r.score >= g.min).rows.push(r);
  return `<div class="recs tiers">${groups.filter((g) => g.rows.length).map((g) => `
    <div class="tier-group">
      <span class="tier t-${g.label[0]}">${g.label}</span>
      <div class="tier-tiles">${g.rows.map((r) => `
        <button type="button" class="tile ${r.championId === hoverId ? 'hovering' : ''} ${r.unsure ? 'unsure' : ''}" data-hover="${r.championId}" ${canHover ? '' : 'disabled'} title="${esc(champName(r.championId))} · ${r.score}">
          ${champImg(r.championId)}
          <b class="tscore sc-${tierOf(r.score)}">${r.score}</b>
        </button>`).join('')}</div>
    </div>`).join('')}</div>`;
}

const NEED_NAME = { fr: 'Frontline', cc: 'Crowd control', en: 'Engage', wc: 'Waveclear', ac: 'Area control', pk: 'Poke', pe: 'Peel', sc: 'Scaling', pi: 'Pick power', sp: 'Split push' };

// Where the expected win chance of a pick comes from: each part in percentage points of win
// chance, added one after another from an even game so they sum to the final number
function modelExplanation(row) {
  if (!row?.parts) return '';
  const P = row.parts;
  const win = (z) => 100 / (1 + Math.exp(-z)) - 50;
  const icons = (items, sign) => (items || []).filter((x) => x.value * sign > 0).slice(0, 3).map((x) => champImg(x.championId, 's')).join('');
  const items = [
    { icon: 'strength', label: 'Champion strength', z: P.strength },
    { icon: 'synergy', label: 'Team synergy', z: P.synergy + P.ahead, detail: icons(row.allies, P.synergy >= 0 ? 1 : -1) },
    { icon: 'matchup', label: 'Enemy matchups', z: P.matchup, detail: icons(row.enemies, P.matchup >= 0 ? 1 : -1) },
    { icon: 'balance', label: 'AP/AD balance', z: P.damage },
    { icon: 'guard', label: 'CC, frontline, engage', z: P.needs, detail: (row.lacking || []).map((k) => (ICONS[k] ? glyph(k, `Missing: ${NEED_NAME[k] || k}`) : '')).join('') },
    { icon: 'flag', label: 'Comp plan fit', z: P.plan },
    { icon: 'focus', label: 'Team coordination', z: P.coherence },
    { icon: 'eye', label: 'Counter exposure', z: P.exposure },
    { icon: 'lane', label: 'Lane', z: P.lane },
    { icon: 'user', label: 'Personal fit', z: P.personal },
    { icon: 'dots', label: 'Other factors', z: P.learned + P.typical },
  ];
  let cum = 0;
  for (const it of items) {
    const before = win(cum);
    cum += it.z;
    it.pp = win(cum) - before;
  }
  const fmt = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
  const line = (it) => `<div class="wf-row ${it.pp > 0 ? 'up' : 'down'}">
    ${glyph(it.icon, it.label)}
    <div class="wf-track"><span class="neg"><i data-w="${it.pp < 0 ? Math.min(100, Math.abs(it.pp) * 25) : 0}"></i></span><span class="pos"><i data-w="${it.pp > 0 ? Math.min(100, it.pp * 25) : 0}"></i></span></div>
    <b>${fmt(it.pp)}</b>
    ${it.detail ? `<span class="wf-detail">${it.detail}</span>` : ''}
  </div>`;
  const name = champName(row.championId);
  return `<section class="explanation" aria-label="Win chance breakdown: ${esc(name)}">
    <div class="explanation-head" title="Expected win chance against a typical pick in this role">
      ${champImg(row.championId, 's')}<strong>${(50 + win(cum)).toFixed(1)}<small>%</small></strong>
    </div>
    <div class="wf-list">${items.filter((it) => Math.abs(it.pp) >= 0.05).map(line).join('')}</div>
  </section>`;
}

// A ban suggestion: score 0-100 for how much banning it helps (see model.js)
function banTile(r, { canHover, hoverId }) {
  const pct = r.pickChance * 100;
  return `
    <button type="button" class="tile ban ${r.championId === hoverId ? 'hovering' : ''}" data-hover="${r.championId}" data-kind="ban" ${canHover ? '' : 'disabled'}
      title="${esc(champName(r.championId))} · ${esc(ROLE_NAME[r.role] || '')} · pick chance ${pct < 1 ? pct.toFixed(1) : Math.round(pct)}%">
      ${champImg(r.championId)}
      <span class="trole">${roleIcon(r.role)}</span>
      <b class="tscore sc-${tierOf(r.score)}">${r.score}</b>
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

const pickOrderUi = { gameId: null, order: null, pending: null, pendingKey: null, timer: null, lockedSignature: null, dirty: false };
const PICK_ORDER_STABILITY_MS = 2500; // a better order must hold this long before it replaces the shown one
const PICK_ORDER_MIN_GAIN = 4; // points the plan must save to change it (see Engine.planPickOrder)

// plan: Engine.planPickOrder result. The shown order is kept unless a new lock-in made another
// order clearly cheaper, and that stays true for PICK_ORDER_STABILITY_MS.
function stabilizedPickOrder(d, rated, plan, lockedChanged) {
  if (pickOrderUi.gameId !== d.gameId) {
    clearTimeout(pickOrderUi.timer);
    Object.assign(pickOrderUi, { gameId: d.gameId, order: null, pending: null, pendingKey: null, timer: null, lockedSignature: null, dirty: false });
  }
  if (lockedChanged) pickOrderUi.dirty = true;
  const desired = plan.order;
  // Whoever has locked in leaves the shown order; the others keep their places
  const left = new Set(desired);
  const previous = (pickOrderUi.order || []).filter((cellId) => left.has(cellId));
  const sameSet = previous.length === desired.length;
  const improvement = sameSet ? plan.costOf(previous) - plan.costOf(desired) : Infinity;
  const result = Engine.stabilizePickOrder(sameSet ? previous : [], pickOrderUi.pending, desired, Date.now(), PICK_ORDER_STABILITY_MS, !pickOrderUi.order || pickOrderUi.dirty, improvement, PICK_ORDER_MIN_GAIN);
  pickOrderUi.order = result.order;
  pickOrderUi.pending = result.pending;
  if (!result.pending) pickOrderUi.dirty = false;
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
    Object.assign(pickOrderUi, { gameId: d.gameId, order: null, pending: null, pendingKey: null, timer: null, lockedSignature: null });
  }
  // The order depends on the locked picks and the roles only, never on hovers
  const lockedSignature = [...d.ally, ...d.enemy].filter((p) => p.locked && p.championId).map((p) => `${p.cellId}:${p.championId}`).join(',');
  const lockedChanged = pickOrderUi.lockedSignature !== null && pickOrderUi.lockedSignature !== lockedSignature;
  pickOrderUi.lockedSignature = lockedSignature;
  const nameOf = (p) => (p.isLocal ? S.me?.nickname : memberByPuuid(p.puuid)?.nickname) || ROLE_NAME[p.position];
  const rated = remaining.map((p) => {
    const playerId = p.isLocal ? S.me?.id : memberByPuuid(p.puuid)?.id;
    // A teammate's hover is shown, but does not move the order
    return { p, championId: !p.isLocal && p.hoverId ? p.hoverId : 0, risk: 0, matchup: 0, personal: 0, poolDepth: poolDepthOf(playerId, p.position) };
  });
  const enemyPicks = d.enemy.filter((p) => p.locked && p.championId);
  const lockedAllies = d.ally.filter((p) => p.locked && p.championId).map((p) => ({ championId: p.championId, position: p.position }));
  const plan = Engine.planPickOrder({ model: S.model, remaining: rated, enemyPicks, sequence: d.pickSequence || [], lockedAllies });
  const suggested = stabilizedPickOrder(d, rated, plan, lockedChanged);
  const trades = Engine.pickOrderTrades(rated, suggested, d.allyPickGroups || []);
  return `
    <div class="pick-order">
      <h3 class="sub" title="Ordered by role and enemy locks; hovers do not change it">Pick Order</h3>
      <ol>${suggested.map((r) => `<li title="${esc(ROLE_NAME[r.p.position])}">${roleGlyph(r.p.position)}${r.championId ? champImg(r.championId, 's') : ''}<b>${esc(nameOf(r.p))}</b></li>`).join('')}</ol>
      ${trades.slice(0, 2).map(([a, b]) => `<p class="trade" title="Suggested pick trade"><b>${esc(nameOf(a))}</b>${icon('swap')}<b>${esc(nameOf(b))}</b></p>`).join('')}
    </div>`;
}

// The game plan once every champion is locked (it stays through the game). Every number is
// the model's, in percentage points of win chance, so they can be compared.
const signedPct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;
const pctClass = (v, edge) => (v >= edge ? 'up' : v <= -edge ? 'down' : '');
const PLAN_PARTS = [
  ['champions', 'star', 'Champion strength by role'],
  ['synergy', 'synergy', 'Same-team pair synergy, both teams'],
  ['matchups', 'matchup', 'Champion-versus-enemy matchups'],
  ['composition', 'hex', 'Team composition interaction'],
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
  const iconRow = (name, title, v) => row(glyph(name, title), v, title);
  const lanes = plan.lanes.filter(Boolean).map((l) => row(
    roleGlyph(l.role),
    l.pct,
    l.games ? `${champName(l.ours)} vs ${champName(l.theirs)}: ${l.games} games` : `${champName(l.ours)} vs ${champName(l.theirs)}: champion averages`,
    `<span class="pvs">${champImg(l.ours, 's')}${champImg(l.theirs, 's')}</span>`,
  )).join('');
  const chance = Math.round(plan.winChance * 100);
  return `
    <div class="game-plan">
      <h3 class="sub head-row"><span>Game Plan</span><span class="hint" title="Draft win chance"><b class="${pctClass(chance - 50, E)}">${chance}%</b></span></h3>
      <div class="plan-grid">
        <div class="plan-block">${PLAN_PARTS.map(([k, name, title]) => iconRow(name, title, plan.parts[k])).join('')}</div>
        <div class="plan-block">
          ${iconRow('sun', 'Early game: lanes and first objectives, first 15 minutes', plan.early)}
          ${iconRow('moon', 'Later game: remaining draft edge', plan.later)}
          ${iconRow('objective', 'First blood, tower, dragon, herald, grubs', plan.objectives)}
        </div>
        <div class="plan-block lanes-block">${lanes}</div>
      </div>
    </div>`;
}
// Runes, items and spells for our pick, once every champion is locked; sent to the client
// on their own when the options say so, else with the Apply buttons
const BUCKET_TEXT = { any: 'General', ap: 'vs AP', ad: 'vs AD', mixed: 'vs Mixed' };
function buildHtml() {
  const pick = S.currentBuild;
  if (!pick) return '<div class="build"><h3 class="sub">Build</h3></div>';
  const { build } = pick;
  const perks = S.gameData?.perks || {};
  const spells = S.gameData?.summoner || {};
  const perkImg = (id) => (perks[id] ? `<img src="https://ddragon.leagueoflegends.com/cdn/img/${perks[id].icon}" alt="" title="${esc(perks[id].name)}">` : '');
  const itemImg = (id, title) => `<img src="https://ddragon.leagueoflegends.com/cdn/${S.patch}/img/item/${id}.png" alt="" title="${esc(title || S.gameData?.items?.[id] || '')}">`;
  const pathHtml = (steps) => (steps?.length ? `<span class="item-group item-path">${glyph('route', 'Build order')}<span>${steps.map((s) => `<span class="step">${s.parts.map((p) => `<span class="part">${itemImg(p)}</span>`).join('')}${s.parts.length ? '<i>→</i>' : ''}${itemImg(s.id)}</span>`).join('')}</span></span>` : '');
  const spellImg = (id) => (spells[id] ? `<img src="https://ddragon.leagueoflegends.com/cdn/${S.patch}/img/spell/${spells[id].image}" alt="" title="${esc(spells[id].name)}">` : '');
  const applied = S.applied?.gameId === S.draft?.gameId ? S.applied.parts || {} : {};
  const state = (part) => (applied[part] === true ? `<span class="ok">${glyph('check', 'Applied')}</span>` : applied[part] === false ? `<span class="fail">${glyph('cross', 'Apply failed')}</span>` : '');
  const apply = (part, title) => `<button class="btn ghost icon-btn" data-apply="${part}" title="${title}" aria-label="${title}">${icon('apply')}</button>`;
  const keystone = build.runes.perks[0];
  const group = (name, label, ids, title) => (ids?.length ? `<span class="item-group">${glyph(name, label)}<span>${ids.map((id) => itemImg(id, title?.(id))).join('')}</span></span>` : '');
  const situational = pick.situational || [];
  const why = new Map(situational.map((x) => [x.id, `${S.gameData?.items?.[x.id] || ''}: +${(x.value * 100).toFixed(1)}% win chance vs ${x.reasons.join(', ')}`]));
  return `
    <div class="build">
      <h3 class="sub head-row"><span>Build</span><span class="hint" title="${build.games} games">${BUCKET_TEXT[pick.bucket] || ''}</span></h3>
      <div class="build-row">
        <div class="build-part runes" title="${esc(perks[keystone]?.name || '')} · ${esc(perks[build.runes.primary]?.name || '')} · ${esc(perks[build.runes.sub]?.name || '')}">${perkImg(keystone)}${perkImg(build.runes.primary)}${perkImg(build.runes.sub)}${state('runes')}${apply('runes', 'Apply runes')}</div>
        <div class="build-part items">
          ${group('bag', 'Starting items', build.items.start)}
          ${build.items.path?.length ? pathHtml(build.items.path) : `${group('gem', 'Core items', build.items.core)}${group('boot', 'Boots', build.items.boots ? [build.items.boots] : [])}`}
          ${group('shuffle', 'Situational items', situational.map((x) => x.id), (id) => why.get(id))}
          ${state('items')}${apply('items', 'Apply item set')}
        </div>
        <div class="build-part spells">${build.spells.map(spellImg).join('')}${state('spells')}${apply('spells', 'Apply summoner spells')}</div>
      </div>
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
    ? `<small class="${ev.score > atPick ? 'up' : 'down'}" title="Score when locked: ${atPick}">${ev.score > atPick ? '▲' : '▼'}${atPick}</small>`
    : ev.offRole ? `<small class="warn">${glyph('warn', 'Off-role')}</small>` : '';
  return `
    <div class="slot-score ${p.locked ? '' : 'pending'} ${ev.unsure ? 'unsure' : ''}"${ev.unsure ? ` title="Low sample: ±${ev.uncertainty}"` : ''}>
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
    return `<div class="lg-row">${champImg(p.championId, 's')}${roleGlyph(p.position)}${sc === null ? '<span></span>' : `<b class="sc sc-${tierOf(sc)}">${sc}</b>`}<span>${st.kills ?? '–'}/${st.deaths ?? '–'}/${st.assists ?? '–'}</span><span>${st.cs ?? '–'} cs</span><span>${st.damage != null ? `${(st.damage / 1000).toFixed(1)}k` : '–'}</span></div>`;
  }).join('');
  const avg = (list, other) => {
    const v = list.map((p) => scoreOf(p, list, other)).filter((x) => x !== null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const ourAvg = avg(allies, enemies);
  const theirAvg = avg(enemies, allies);
  const chance = plan ? Math.round(plan.winChance * 100) : null;
  return `
    <div class="last-game">
      <div class="lg-head">
        <h2>Last Game <span class="${g.win ? 'win' : 'loss'}">${g.win ? 'Win' : g.win === false ? 'Loss' : ''}</span></h2>
        <span class="muted">${g.durationS ? `${Math.floor(g.durationS / 60)}:${String(g.durationS % 60).padStart(2, '0')}` : ''}</span>
        ${chance !== null ? `<span class="lg-chance" title="Draft win chance">Draft <b>${chance}%</b></span>` : ''}
      </div>
      <div class="lg-teams">
        <div><h3 class="sub">Ally ${ourAvg !== null ? `<b class="sc sc-${tierOf(ourAvg)}">${ourAvg}</b>` : ''}</h3>${rows(allies, enemies, 'ally')}</div>
        <div><h3 class="sub">Enemy ${theirAvg !== null ? `<b class="sc sc-${tierOf(theirAvg)}">${theirAvg}</b>` : ''}</h3>${rows(enemies, allies, 'enemy')}</div>
      </div>
    </div>`;
}
// ---------- Lineup roles (lobby / queue) ----------
// When all five in the party are team members: who should play which role, from the
// statistics of the Champions tab (season, patch, and the games with exactly these five)
function lineupRolesHtml() {
  const lobby = S.lobby;
  if (!lobby) return '';
  const note = (text) => `<div class="lineup-roles"><h3>Lineup Roles</h3><p class="note">${esc(text)}</p></div>`;
  const sameId = (a, b) => a && b && String(a).toLowerCase() === String(b).toLowerCase();
  const people = lobby.members.map((m) => {
    const member = (m.isLocal && S.me) || memberByPuuid(m.puuid) || S.members.find((x) => sameId(x.riot_id, m.riotId));
    return member ? { id: member.id, roles: member.roles || [], preferences: m.preferences } : null;
  });
  const known = people.filter(Boolean).length;
  if (lobby.members.length < 5) return note(`Lobby members: ${lobby.members.length}/5`);
  if (known < 5 || new Set(people.map((p) => p?.id)).size !== 5) return note(`Linked team members: ${known}/5`);
  const result = Engine.lineupRoles({ model: S.model, members: people, playerStats: S.playerStats });
  if (!result) return '';
  const [best, ...others] = result.options;
  const signed = (n) => `<b class="${n > 0 ? 'up' : n < 0 ? 'down' : ''}">${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}</b>`;
  const label = { season: 'Season', history: 'Patch', team: 'With team' };
  const order = (option) => [...option.picks].sort((a, b) => ROLES.findIndex(([r]) => r === a.role) - ROLES.findIndex(([r]) => r === b.role));
  const row = (p) => `
    <div class="lr-row" title="${esc(Object.entries(p.parts).map(([k, v]) => `${label[k]} ${v.games}g`).join(' · ') || 'No games')}">
      ${roleGlyph(p.role)}
      <b class="lr-who">${esc(nickOf(p.id))}</b>
      <span class="lr-champs">${p.champions.map((c) => champImg(c, 's')).join('')}</span>
      ${signed(p.points)}
    </div>`;
  const close = result.margin < 3;
  return `
    <div class="lineup-roles">
      <h3>Lineup Roles ${close ? '<small title="Top options score within 3 points">close</small>' : ''}</h3>
      ${order(best).map(row).join('')}
      ${others.length ? `<details><summary>Alternatives</summary>${others.map((o) => `
        <div class="lr-alt">${order(o).map((p) => `<span title="${esc(ROLE_NAME[p.role])}">${roleGlyph(p.role)}${esc(nickOf(p.id))}</span>`).join('')}<b class="down">${o.total - best.total}</b></div>`).join('')}</details>` : ''}
    </div>`;
}
// ---------- Comp: what each team is turning into ----------
const classOf = (championId) => champMap().get(championId)?.tags?.[0] || S.model?.tags?.[championId] || 'None';
function compCard(title, ids, mine) {
  const comp = Traits.compProfile(ids.map((id) => ({ id, tag: classOf(id) })));
  const lead = comp.plan && !comp.mixed ? comp.plan : null;
  const plans = comp.plans.map((p) => `
    <span class="plan ${lead === p.key ? 'lead' : ''}" title="${esc(p.name)}: ${Math.round(p.share * 100)}%" role="img" aria-label="${esc(p.name)}">
      ${icon(p.key)}<i class="plan-fill" data-w="${Math.round(p.share * 100)}"></i>
    </span>`).join('');
  const needs = comp.needs.map((n) => `
    <span class="need ${n.state}" title="${esc(n.name)}" role="img" aria-label="${esc(n.name)}: ${n.state}">${icon(n.key)}</span>`).join('');
  const ap = Math.round(comp.damage.ap * 100);
  return `
    <div class="comp-card ${mine ? 'ours' : 'theirs'}" title="${esc(title)}: ${esc(comp.label)}">
      ${comp.n ? `<div class="plans">${plans}</div><div class="needs">${needs}</div>
      <div class="dmg ${comp.damage.state}" title="Damage split: ${100 - ap}% AD, ${ap}% AP">${icon('sword')}<div class="dmg-track"><i data-w="${ap}"></i></div>${icon('wand')}</div>` : ''}
    </div>`;
}
function compHtml(d) {
  const ours = d.ally.map(shownChamp).filter(Boolean);
  const theirs = d.enemy.map(shownChamp).filter(Boolean);
  if (!ours.length && !theirs.length) return '';
  return `<section class="comp" aria-label="Team compositions">${compCard('Ally comp', ours, true)}${compCard('Enemy comp', theirs, false)}</section>`;
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
        <p class="kicker">${connected ? '接続' : '待機'}</p>
        <h2 class="waiting-title">${connected ? 'Waiting for Champ Select' : 'League Client Not Detected'}</h2>
        <div class="scan"><span class="scan-dot"></span>${connected ? esc(PHASE_TEXT[S.lcu?.phase] || 'Idle') : 'Searching for client'}</div>
        ${connected ? lineupRolesHtml() : ''}
        ${S.stats?.meta?.length ? '' : '<p class="waiting-text small">No meta data. The collector has not run yet.</p>'}
      </div>`;
    return;
  }

  const blocked = unavailable(d);
  const turnKind = d.turn?.kind === 'ban' ? 'Ban' : 'Pick';
  const turnHtml = !d.turn
    ? `<span>${esc(d.phase === 'FINALIZATION' ? 'Finalization' : PHASE_TEXT[S.lcu?.phase] || 'Waiting')}</span>`
    : `${icon(d.turn.kind === 'ban' ? 'ban' : 'pick')}<span>${d.isOurTurn ? `Your ${turnKind}` : d.turn.side === 'ally' ? 'Ally' : 'Enemy'}</span>`;
  // Our team is always on the left, whichever side we play
  const allyCol = sideColumn('ally', d);
  const enemyCol = sideColumn('enemy', d);

  const local = d.ally.find((p) => p.isLocal);
  const role = local?.position || '';
  const hasStats = S.stats?.meta?.length > 0;
  // Only the role being played: without a role there is no pool to apply
  const poolRule = Engine.poolPickable(role ? poolFilter(role) : null, S.pickable, (S.champions || []).map((c) => c.id));
  const recs = local?.locked
    ? []
    : Engine.recommend({
        stats: S.stats, model: S.model,
        role,
        // Teammates' hovers are taken too: don't suggest what a friend is about to pick
        unavailable: new Set([...blocked, ...d.ally.filter((p) => !p.isLocal && shownChamp(p)).map(shownChamp)]),
        pickable: poolRule.pickable,
        keep: poolRule.keep,
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
        history: S.teamHistory?.byChampion || null,
        limit: 10,
      })
    : [];
  const banBlock = d.myBanActionId
    ? `<div>
        <h3 class="sub head-row"><span class="head-ic">${glyph('ban', 'Ban suggestions')}Bans</span></h3>
        ${bans.length
          ? `<div class="recs tiers" data-kind="ban"><div class="tier-group"><div class="tier-tiles">${bans.map((r) => banTile(r, { canHover: true, hoverId: d.banHoverId })).join('')}</div></div></div>`
          : '<p class="note">Requires a trained model.</p>'}
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
      hoverRow = `<div class="recs pinned gap">${recRow(row, 0, { canHover: false, hoverId: local.hoverId, rank: '•' })}</div>`;
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
      : poolRule.active && hasStats
        ? `<p class="note pool-empty">No pool champions for this role. <button type="button" class="link" data-pool-mode="off" data-pool-for="${role}">Show all</button></p>`
        : `<p class="note">${hasStats ? 'No pickable champions for this role.' : 'No meta data. The collector has not run yet.'}</p>`;

  $view.innerHTML = `
    <div class="board">
      ${allyCol}
      <section class="center">
        <div class="phasebox ${d.isOurTurn ? 'mine' : ''}">
          <div class="turn-row">
            <div class="turn ${d.isOurTurn ? 'mine' : ''}">${turnHtml}</div>
            <div class="secs" id="tsec"></div>
          </div>
          <div class="timer"><div id="tbar"></div></div>
        </div>
        ${banBlock}
        ${compHtml(d)}
        ${pickOrderHtml(d, blocked)}
        <div>
          <h3 class="sub head-row"><span class="head-ic">${local?.locked ? glyph('pick', 'Locked pick') : role ? roleGlyph(role) : ''}${local?.locked ? 'Your Pick' : `Picks${role ? ` · ${ROLE_NAME[role]}` : ''}`}</span>${local?.locked || !role ? '' : poolSwitchHtml(role)}</h3>
          ${recommendationContent}
        </div>
      </section>
      ${enemyCol}
    </div>`;

  // Inline style attributes are blocked by the CSP, so bar widths are set here
  for (const bar of $view.querySelectorAll('[data-w]')) bar.style.width = `${bar.dataset.w}%`;
  for (const b of $view.querySelectorAll('[data-pool-mode]')) b.onclick = () => setPoolMode(b.dataset.poolFor, b.dataset.poolMode);
  const poolEdit = $view.querySelector('[data-pool-edit]');
  if (poolEdit) {
    poolEdit.onclick = () => {
      poolUi.role = poolEdit.dataset.poolEdit;
      tab = 'pool';
      renderMain();
    };
  }
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
    const roleMark = roleLabel ? `<span class="slot-role ${p.roleGuessed ? 'guess' : ''}">${roleGlyph(p.position, p.roleGuessed ? `${roleLabel} (estimated)` : roleLabel)}</span>` : '<span class="slot-role"></span>';
    return `
      <div class="${cls}" ${shown ? `title="${esc(champName(shown))}"` : ''}>
        ${roleMark}
        ${champImg(shown, 'l')}
        ${shown ? slotScore(d, which, p, shown, scores) : mini}
      </div>`;
  });

  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  return `
    <section class="side ${color}">
      <div class="side-head" title="${color === 'blue' ? 'Blue side' : 'Red side'}">
        <h2><span class="kanji">${isAlly ? '味方' : '敵'}</span>${isAlly ? 'Ally' : 'Enemy'}</h2>
        ${avg === null ? '' : `<div class="avg" title="Average score"><b class="sc sc-${tierOf(avg)}">${avg}</b></div>`}
      </div>
      ${slots.join('')}
      <div class="bans">${bans.map((id) => champImg(id, 's')).join('')}</div>
    </section>`;
}
// ---------- Champions ----------
const STAT_COLUMNS = [
  { key: 'name', label: 'Champion', value: (r) => champName(r.championId) },
  { key: 'games', label: 'Games', value: (r) => r.games },
  { key: 'winRate', label: 'W–L', title: 'Sorted by win rate', value: (r) => r.wins / r.games },
  { key: 'early', label: 'Lane Δ', title: 'Laning phase versus an average player in the same matchup', value: (r) => r.early },
  { key: 'late', label: 'Late Δ', title: 'Post-laning result beyond the draft and lane', value: (r) => r.late },
  { key: 'delta', label: 'Score Δ', title: "Added to this player's score for the champion", value: (r) => r.delta },
];
// Ties go to the champion with more games
function sortStatRows(rows) {
  const column = STAT_COLUMNS.find((c) => c.key === statsUi.sort) || STAT_COLUMNS.at(-1);
  const direction = statsUi.descending ? -1 : 1;
  return [...rows].sort((x, y) => {
    const [a, b] = [column.value(x), column.value(y)];
    const order = typeof a === 'string' ? a.localeCompare(b) : (a ?? 0) - (b ?? 0);
    return direction * order || y.games - x.games;
  });
}
const statHeader = (column) => {
  const active = statsUi.sort === column.key;
  return `<span role="columnheader" aria-sort="${active ? (statsUi.descending ? 'descending' : 'ascending') : 'none'}"><button type="button" class="sort-head ${active ? 'active' : ''}" data-sort="${column.key}"${column.title ? ` title="${esc(column.title)}"` : ''}>${esc(column.label)}<i aria-hidden="true">${active ? (statsUi.descending ? '▼' : '▲') : ''}</i></button></span>`;
};

// How each player does on each champion (collector/src/players), from three kinds of games:
// their ranked games of the season, those of the patch, and those with team members on
// their side (per line-up). Games, record, and the effect split into the laning phase and
// the rest of the game.
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
    ? sortStatRows(Object.entries(stats.byKey)
        .map(([key, v]) => ({ championId: Number(key.split(':')[0]), role: key.split(':')[1], ...v })))
    : [];
  const empty = {
    season: 'No ranked games this season.',
    history: 'No ranked games on this patch.',
    team: 'No ranked games with a full five-member lineup.',
  }[source[0]];
  $view.innerHTML = `
    <div class="champ-stats">
      <div class="toolbar">
        <p class="note source-note">${{
          season: 'All ranked games this season. Input to the personal score layer.',
          history: 'Ranked games on the current patch. Input to the personal score layer.',
          team: 'Ranked games with five team members. Applied only when the same lineup is drafted.',
        }[source[0]]}</p>
        <span class="grow"></span>
        <div class="toolbar-actions">
          ${lineups.length && source[0] === 'team' ? renderLineupPicker(lineups, lineup, id) : ''}
          <select id="who" class="who-select">${members.map((m) => `<option value="${m.id}" ${m.id === id ? 'selected' : ''}>${esc(m.nickname)}</option>`).join('')}</select>
        </div>
      </div>
      ${rows.length
        ? `<div class="stats-table">
            <div class="stats-row head" id="statsHead">${STAT_COLUMNS.map(statHeader).join('')}</div>
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
          <p class="note">Unplayed champion baseline: ${signed(pts(stats.unplayed))}</p>`
        : `<p class="note">${empty}</p>`}
    </div>`;
  document.getElementById('who').onchange = (e) => {
    statsUi.player = e.target.value;
    statsUi.lineup = null;
    renderChampions();
  };
  const head = document.getElementById('statsHead');
  if (head) {
    head.onclick = (e) => {
      const key = e.target.closest('[data-sort]')?.dataset.sort;
      if (!key) return;
      // The same column turns around; a new one starts high to low, names from A
      statsUi.descending = key === statsUi.sort ? !statsUi.descending : key !== 'name';
      statsUi.sort = key;
      renderChampions();
    };
  }
  attachLineupPicker();
}

// ---------- Champion pool ----------
// The player's own limit on the draft's recommendations, kept on this computer per account.
// Every role has its own list and its own switch for what the list means, so a choice for one
// role has no effect while playing another, and turning a list off or around loses nothing.
const POOL_MODES = [
  { mode: 'off', label: 'All Champions', icon: 'all', note: () => 'Recommendations use every champion.' },
  { mode: 'include', label: 'Include Only', icon: 'pick', note: (n) => (n ? `Recommendations are limited to ${n} selected ${n === 1 ? 'champion' : 'champions'}.` : 'Select champions to limit the recommendations to.') },
  { mode: 'exclude', label: 'Exclude', icon: 'ban', note: (n) => (n ? `${n} selected ${n === 1 ? 'champion is' : 'champions are'} left out of the recommendations.` : 'Select champions to leave out of the recommendations.') },
];
const POOL_STAMP = { include: '選', exclude: '禁' };
const POOL_ROLE_SHARE = 0.05; // share of a champion's games, to list it under a role
const poolUi = { owner: undefined, pools: null, role: '', query: '' };

function poolFilter(role) {
  const owner = S?.me?.id || null;
  if (poolUi.owner !== owner) {
    poolUi.owner = owner;
    poolUi.pools = Engine.poolsByRole(store.get(`pool.filters.${owner}`, null), store.get(`pool.filter.${owner}`, null));
  }
  return poolUi.pools[role];
}
const savePoolFilters = () => store.set(`pool.filters.${poolUi.owner}`, poolUi.pools);

function setPoolMode(role, mode) {
  poolFilter(role).mode = mode;
  savePoolFilters();
  renderMain();
}

// The role the page opens on: the one being drafted, the last one open, the player's first
function poolPageRole() {
  const drafted = S.draft?.ally?.find((p) => p.isLocal)?.position;
  if (ROLE_NAME[drafted]) return drafted;
  return ROLE_NAME[poolUi.role] ? poolUi.role : (S.me?.roles || []).find((r) => ROLE_NAME[r]) || ROLES[0][0];
}

// The switch next to the draft's picks
function poolSwitchHtml(role) {
  const { mode, champions } = poolFilter(role);
  return `<span class="pool-switch" role="group" aria-label="Champion pool">
    ${POOL_MODES.map((m) => `<button type="button" class="${m.mode === mode ? `on ${m.mode}` : ''}" data-pool-mode="${m.mode}" data-pool-for="${role}" title="${ROLE_NAME[role]}: ${m.label}" aria-label="${ROLE_NAME[role]}: ${m.label}" aria-pressed="${m.mode === mode}">${icon(m.icon)}</button>`).join('')}
    <button type="button" class="pool-edit" data-pool-edit="${role}" title="Edit ${ROLE_NAME[role]} pool" aria-label="Edit ${ROLE_NAME[role]} pool">${icon('pool')}${champions.length ? `<b>${champions.length}</b>` : ''}</button>
  </span>`;
}

// Roles a champion is played in, from the model, else the meta statistics; empty when unknown
function poolRolesOf(championId) {
  const out = new Set();
  ROLES.forEach(([role], r) => {
    if ((S.model?.champ?.[`${championId}:${r}`]?.[2] || 0) >= POOL_ROLE_SHARE) out.add(role);
  });
  if (!out.size) for (const row of S.stats?.meta || []) if (row.champion_id === championId && row.role) out.add(row.role);
  return out;
}

function paintPool() {
  const { mode, champions } = poolFilter(poolUi.role);
  const chosen = new Set(champions);
  const stamp = POOL_STAMP[mode] || '';
  for (const b of $view.querySelectorAll('[data-pool-set]')) {
    const on = b.dataset.poolSet === mode;
    b.className = on ? `on ${mode}` : '';
    b.setAttribute('aria-pressed', String(on));
  }
  const query = poolUi.query.trim().toLowerCase();
  for (const tile of $view.querySelectorAll('[data-pool-champ]')) {
    const id = Number(tile.dataset.poolChamp);
    const selected = chosen.has(id);
    tile.classList.toggle('selected', selected);
    tile.setAttribute('aria-pressed', String(selected));
    tile.querySelector('.stamp').textContent = selected ? stamp : '';
    // The role's usual champions; a search reaches any champion, for an off-meta pick
    const fits = selected || !tile.dataset.roles || tile.dataset.roles.split(',').includes(poolUi.role);
    tile.hidden = query ? !tile.dataset.name.includes(query) : !fits;
  }
  for (const b of $view.querySelectorAll('[data-pool-role]')) {
    const on = b.dataset.poolRole === poolUi.role;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    // What each role's pool does, seen from any role
    const pool = poolFilter(b.dataset.poolRole);
    const badge = b.querySelector('b');
    badge.textContent = pool.champions.length || '';
    badge.className = pool.mode;
  }
  document.getElementById('poolNote').textContent = `${ROLE_NAME[poolUi.role]}: ${POOL_MODES.find((m) => m.mode === mode).note(champions.length)}`;
  document.getElementById('poolClear').disabled = !champions.length;
  const page = $view.querySelector('.pool-page');
  page.dataset.mode = mode;
}

function renderPool() {
  poolUi.role = poolPageRole();
  const champions = [...(S.champions || [])].sort((a, b) => a.name.localeCompare(b.name));
  $view.innerHTML = `
    <div class="pool-page">
      <div class="pool-bar">
        <span class="pool-roles" role="group" aria-label="Role">
          ${ROLES.map(([role, name]) => `<button type="button" data-pool-role="${role}" title="${name}" aria-label="${name}">${roleIcon(role)}<span>${name}</span><b></b></button>`).join('')}
        </span>
        <div class="pool-seg" role="group" aria-label="Pool mode">
          ${POOL_MODES.map((m) => `<button type="button" data-pool-set="${m.mode}">${icon(m.icon)}<span>${m.label}</span></button>`).join('')}
        </div>
        <label class="pool-search">${icon('search')}<input id="poolSearch" type="search" placeholder="Search champion" aria-label="Search champion" value="${esc(poolUi.query)}"></label>
        <span class="grow"></span>
        <button type="button" class="btn ghost" id="poolClear">Clear</button>
      </div>
      <p class="note source-note" id="poolNote"></p>
      <div class="pool-grid" id="poolGrid">
        ${champions.map((c) => `
          <button type="button" class="pool-tile" data-pool-champ="${c.id}" data-name="${esc(c.name.toLowerCase())}" data-roles="${[...poolRolesOf(c.id)].join(',')}" title="${esc(c.name)}">
            ${champImg(c.id)}<i class="stamp" aria-hidden="true"></i><span>${esc(c.name)}</span>
          </button>`).join('')}
      </div>
    </div>`;
  document.getElementById('poolGrid').onclick = (e) => {
    const tile = e.target.closest('[data-pool-champ]');
    if (!tile) return;
    const filter = poolFilter(poolUi.role);
    const id = Number(tile.dataset.poolChamp);
    filter.champions = filter.champions.includes(id) ? filter.champions.filter((x) => x !== id) : [...filter.champions, id];
    savePoolFilters();
    paintPool();
  };
  for (const b of $view.querySelectorAll('[data-pool-set]')) {
    b.onclick = () => {
      poolFilter(poolUi.role).mode = b.dataset.poolSet;
      savePoolFilters();
      paintPool();
    };
  }
  for (const b of $view.querySelectorAll('[data-pool-role]')) {
    b.onclick = () => {
      poolUi.role = b.dataset.poolRole;
      paintPool();
    };
  }
  document.getElementById('poolSearch').oninput = (e) => {
    poolUi.query = e.target.value;
    paintPool();
  };
  document.getElementById('poolClear').onclick = () => {
    poolFilter(poolUi.role).champions = [];
    savePoolFilters();
    paintPool();
  };
  paintPool();
}

// ---------- Team ----------
// Role changes show at once and are saved behind the scenes: the newest wanted set is sent
// when the previous save returns, and a failed save puts the last saved roles back.
const roleSave = { want: null, sending: false, confirmed: null };

function applyLocalRoles(roles) {
  if (S.me) S.me = { ...S.me, roles };
  S.members = (S.members || []).map((m) => (m.id === S.me?.id ? { ...m, roles } : m));
}

function paintRoleTiles() {
  const roles = new Set(S.me?.roles || []);
  for (const tile of $view.querySelectorAll('[data-role]')) {
    const on = roles.has(tile.dataset.role);
    tile.classList.toggle('on', on);
    tile.setAttribute('aria-pressed', String(on));
  }
}

async function flushRoles() {
  if (roleSave.sending) return;
  roleSave.sending = true;
  while (roleSave.want) {
    const sent = roleSave.want;
    const res = await api.saveRoles(sent);
    if (!res.ok) {
      roleSave.want = null;
      applyLocalRoles(roleSave.confirmed || []);
      if (tab === 'team') paintRoleTiles();
      toast(res.error, 'error');
      break;
    }
    roleSave.confirmed = sent;
    if (roleSave.want === sent) roleSave.want = null;
  }
  roleSave.sending = false;
}

function toggleRole(role) {
  if (!roleSave.want && !roleSave.sending) roleSave.confirmed = S.me?.roles || [];
  const roles = new Set(S.me?.roles || []);
  if (roles.has(role)) roles.delete(role);
  else roles.add(role);
  const next = ROLES.map(([r]) => r).filter((r) => roles.has(r));
  roleSave.want = next;
  applyLocalRoles(next);
  paintRoleTiles();
  flushRoles();
}

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
            <div class="muted small">${m.riot_id ? esc(m.riot_id) : 'Riot account not linked'}</div>
            ${mine ? `<div class="roles-label">Roles</div><div class="role-tiles">${chips}</div>` : `<div class="role-tags">${chips || '<span class="muted small">No roles set</span>'}</div>`}
            ${isOwner && m.id !== S.me.id ? `<button class="link kick" data-kick="${m.id}" data-name="${esc(m.nickname)}">Remove Member</button>` : ''}
          </div>`;
      }).join('')}
    </div>`;
  $view.querySelector('.members').onclick = async (e) => {
    const chip = e.target.closest('[data-role]');
    if (chip) return toggleRole(chip.dataset.role);
    const b = e.target.closest('[data-kick]');
    if (!b || !confirm(`Remove ${b.dataset.name} from the team?`)) return;
    S = await run(api.kickMember(b.dataset.kick));
    toast(`Removed ${b.dataset.name}`);
    renderMain();
  };
  document.getElementById('copy').onclick = () => navigator.clipboard.writeText(t.join_code).then(() => toast('Invite code copied'));
  document.getElementById('out').onclick = signOut;
  document.getElementById('prof').onclick = () => {
    screen = 'profile';
    render();
  };
  document.getElementById('leave').onclick = async () => {
    if (!confirm('Leave this team?')) return;
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
      <span class="grow"></span>
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
          <span class="hme">${champImg(r.champion_id)}<span><b>${esc(champName(r.champion_id))}</b><small>${ROLE_NAME[r.role] || ''}${kda ? ` · ${kda}` : ''}${r.cs !== null ? ` · ${r.cs} cs` : ''}</small></span></span>
          ${teamHtml(us, r.champion_id)}
          <div class="hscore">${avgHtml(us)}<span class="hvs">vs</span>${avgHtml(them)}</div>
          ${teamHtml(them, null)}
          ${r.lineup ? `<span class="hwith" title="${esc(lineupName(r.lineup, id))}">${icon('users')}<span>${esc(lineupPeople(r.lineup, id).join(', '))}</span></span>` : ''}
        </div>`;
        historyUi.html.set(r.match_id, html);
        return html;
      }).join('')}</div>${historyUi.more ? '<div class="hist-more"><button class="btn ghost" id="hmore">Load More</button></div>' : ''}`
    : `<div class="empty-state"><h2>No Ranked Games</h2><p>${mine ? 'Games appear after the collector syncs them from Riot.' : 'No games available for this player.'}</p></div>`;
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
      if (!confirm('Clear match history? Existing games are hidden from this list. Champion statistics are not affected.')) return;
      S = await run(api.clearHistory());
      toast('History cleared');
      renderHistory();
    };
  }
}

// ---------- Options ----------
// Kept on this computer. General: launch at sign-in. Draft: send runes (with summoner
// spells) and the item set to the client once every champion is locked.
const OPTION_TABS = [
  ['general', 'General', 'seal', [['openAtLogin', 'Launch at Windows sign-in', 'Starts Itachio before the League client']]],
  ['drafting', 'Draft', 'scroll', [
    ['autoRunes', 'Auto-apply runes and spells', 'Sent to the client when all picks are locked'],
    ['autoItems', 'Auto-apply item set', 'Sent to the client when all picks are locked'],
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
