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
const poolUi = { search: '', role: '', selected: null, editRole: '', editComfort: 3 };

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
  if (init.version) document.getElementById('ver').textContent = `v${init.version}`;
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

api.onState((partial) => {
  if (!S) S = {};
  Object.assign(S, partial);
  if (screen === 'main' && 'me' in partial && !partial.me?.team_id) return decideScreen();
  renderStatus();
  // Keep focus while typing on the pool screen: re-render only the affected parts
  if (screen !== 'main') return;
  if (tab === 'draft' && ('draft' in partial || 'pools' in partial || 'lcu' in partial || 'members' in partial)) renderMain();
  if (tab === 'team' && ('members' in partial || 'pools' in partial || 'team' in partial || 'pickScores' in partial)) renderMain();
  if (tab === 'pool' && 'pools' in partial) renderPoolList();
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

function roleOptions(selected) {
  return ROLES.map(([v, n]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${n}</option>`).join('');
}

function renderProfile() {
  const me = S?.me;
  $view.innerHTML = `
    <form class="card" id="f">
      <h2>Player profile</h2>
      <p>Your teammates will see you by this name. Your LoL account links automatically while the client is open.</p>
      <label>Nickname <input name="nickname" required minlength="2" maxlength="32" value="${esc(me?.nickname || S?.lcu?.summoner?.riotId?.split('#')[0] || '')}"></label>
      <label>Main role <select name="mainRole">${roleOptions(me?.main_role || 'middle')}</select></label>
      <button class="btn primary" type="submit">Save profile</button>
      <button class="link" type="button" id="out">Sign out</button>
    </form>`;
  document.getElementById('out').onclick = signOut;
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
  if (tab === 'pool') renderPool();
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
const tierOf = (s) => (s >= 80 ? 'S' : s >= 67 ? 'A' : s >= 55 ? 'B' : s >= 40 ? 'C' : 'D');

function recRow(r, i, { canHover, hoverId, rank }) {
  const tier = tierOf(r.score);
  const hovering = r.championId === hoverId;
  return `
    <button type="button" class="rec ${hovering ? 'hovering' : ''} ${r.unsure ? 'unsure' : ''}" data-hover="${r.championId}"
      ${canHover ? 'title="Hover in the client"' : 'disabled'}>
      <span class="rank">${rank ?? i + 1}</span>
      ${champImg(r.championId)}
      <span class="info">
        <span class="name">${esc(champName(r.championId))}
          <span class="tier t-${tier}">${tier}</span>
          ${r.offRole ? '<span class="badge warn">Off-role</span>' : ''}
          ${r.unsure && !r.offRole ? `<span class="badge" title="Rough estimate: ±${r.uncertainty} points">Low data</span>` : ''}
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

// Score each champion had when it was locked, to show how later picks changed it
const pickScores = { gameId: null, map: new Map() };

// Score of a champion on the board, against everything locked so far.
// Enemy champions are scored from the enemy side: their allies are the enemy picks.
function slotScore(d, which, p, championId, sink) {
  const isAlly = which === 'ally';
  const ev = Engine.evaluate({
    stats: S.stats, model: S.model,
    championId,
    role: p.position || (p.isLocal ? S.me?.main_role || '' : ''),
    ...(isAlly ? draftContext(d, p.cellId) : enemyContext(d, p.cellId)),
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

function renderDraft() {
  clearInterval(timerHandle);
  const d = S.draft;
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

  const allyCol = sideColumn('ally', d);
  const enemyCol = sideColumn('enemy', d);
  const blueCol = d.ourSide === 'blue' ? allyCol : enemyCol;
  const redCol = d.ourSide === 'blue' ? enemyCol : allyCol;

  const local = d.ally.find((p) => p.isLocal);
  const role = local?.position || S.me?.main_role || '';
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
      });

  // Our ban is still open: what to ban, against our picks and intents and their locks
  const bans = d.myBanActionId
    ? Engine.recommendBans({
        model: S.model,
        unavailable: blocked,
        allies: draftContext(d).allies,
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
    const ev = Engine.evaluate({ stats: S.stats, model: S.model, championId: local.championId, role, ...draftContext(d, local.cellId) });
    if (ev) pickRow = `<div class="recs pinned">${recRow({ ...ev, inPool: false }, 0, { canHover: false, rank: '✓' })}</div>`;
  }

  // The champion you are hovering, if it is not already in the list
  let hoverRow = '';
  if (local && !local.locked && local.hoverId && !recs.some((r) => r.championId === local.hoverId)) {
    const ev = Engine.evaluate({ stats: S.stats, model: S.model, championId: local.hoverId, role, ...draftContext(d, local.cellId) });
    if (ev) {
      const row = { ...ev, inPool: myPool().some((p) => p.champion_id === local.hoverId) };
      hoverRow = `<h3 class="sub gap">Your hover</h3><div class="recs pinned">${recRow(row, 0, { canHover: false, hoverId: local.hoverId, rank: '•' })}</div>`;
    }
  }

  $view.innerHTML = `
    <div class="board">
      ${blueCol}
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
      ${redCol}
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

  const slots = players.map((p) => {
    const m = isAlly ? memberByPuuid(p.puuid) : null;
    const shown = p.locked ? p.championId : p.hoverId || 0;
    // Same as the client: roles of our team; enemy roles are hidden in ranked
    const roleLabel = ROLE_NAME[p.position || (p.isLocal ? S.me?.main_role : '')] || '';
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
          ${roleLabel ? `<div class="role">${roleLabel}</div>` : ''}
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

// ---------- Pool ----------
function renderPool() {
  $view.innerHTML = `
    <div class="pool-layout">
      <section>
        <div class="toolbar">
          <input id="q" placeholder="Search champions" value="${esc(poolUi.search)}">
        </div>
        <div class="grid" id="grid"></div>
        <div id="editor"></div>
      </section>
      <section>
        <h2 class="sub">Pool</h2>
        <div id="plist"></div>
      </section>
    </div>`;
  const q = document.getElementById('q');
  q.oninput = () => {
    poolUi.search = q.value;
    renderGrid();
  };
  if (!S.champions.length) {
    document.getElementById('grid').outerHTML =
      '<p class="note">The champion list is empty. Run the sync-ddragon function in Supabase once (see README).</p>';
  } else renderGrid();
  renderEditor();
  renderPoolList();
}

function renderGrid() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const term = poolUi.search.trim().toLocaleLowerCase();
  const inPool = new Set(myPool().map((p) => p.champion_id));
  const list = S.champions.filter((c) => !term || c.name.toLocaleLowerCase().includes(term));
  grid.innerHTML = list
    .map((c) => `
      <button class="gcell ${inPool.has(c.id) ? 'inpool' : ''} ${poolUi.selected === c.id ? 'sel' : ''}" data-id="${c.id}">
        ${champImg(c.id)}<span>${esc(c.name)}</span>
      </button>`)
    .join('');
  grid.onclick = (e) => {
    const b = e.target.closest('.gcell');
    if (!b) return;
    poolUi.selected = Number(b.dataset.id);
    const existing = myPool().find((p) => p.champion_id === poolUi.selected);
    poolUi.editRole = existing?.role || S.me.main_role || 'middle';
    poolUi.editComfort = existing?.comfort || 3;
    renderGrid();
    renderEditor();
  };
}

function starsHtml(value, attr) {
  return `<div class="stars">${[1, 2, 3, 4, 5]
    .map((n) => `<button type="button" class="${n <= value ? 'on' : ''}" ${attr}="${n}" aria-label="Comfort ${n}">★</button>`)
    .join('')}</div>`;
}

function renderEditor() {
  const box = document.getElementById('editor');
  if (!box) return;
  if (!poolUi.selected) return (box.innerHTML = '');
  box.innerHTML = `
    <div class="editor">
      ${champImg(poolUi.selected)}
      <b>${esc(champName(poolUi.selected))}</b>
      <select id="erole">${roleOptions(poolUi.editRole)}</select>
      ${starsHtml(poolUi.editComfort, 'data-c')}
      <button class="btn primary" id="esave">Save to pool</button>
      <button class="x" id="eclose" aria-label="Close">×</button>
    </div>`;
  box.querySelector('#erole').onchange = (e) => (poolUi.editRole = e.target.value);
  box.querySelector('.stars').onclick = (e) => {
    const c = e.target.closest('[data-c]');
    if (!c) return;
    poolUi.editComfort = Number(c.dataset.c);
    renderEditor();
  };
  box.querySelector('#eclose').onclick = () => {
    poolUi.selected = null;
    renderGrid();
    renderEditor();
  };
  box.querySelector('#esave').onclick = async () => {
    await run(api.upsertPool({ championId: poolUi.selected, role: poolUi.editRole, comfort: poolUi.editComfort }));
    toast(`${champName(poolUi.selected)} saved to pool`);
    poolUi.selected = null;
    renderGrid();
    renderEditor();
  };
}

function renderPoolList() {
  const box = document.getElementById('plist');
  if (!box) return;
  const pool = myPool();
  if (!pool.length) {
    box.innerHTML = '<p class="note">No champions yet. Click a champion on the left, then pick its role and how comfortable you are on it.</p>';
    renderGrid();
    return;
  }
  box.innerHTML = ROLES.map(([role, name]) => {
    const items = pool.filter((p) => p.role === role).sort((a, b) => b.comfort - a.comfort);
    if (!items.length) return '';
    return `
      <div class="role-group"><h3>${name}</h3>
        ${items.map((p) => `
          <div class="pool-item">
            ${champImg(p.champion_id, 's')}
            <span class="nm">${esc(champName(p.champion_id))}</span>
            ${starsHtml(p.comfort, `data-set="${p.champion_id}:${p.role}" data-v`)}
            <button class="x" data-del="${p.champion_id}:${p.role}" aria-label="Remove from pool">×</button>
          </div>`).join('')}
      </div>`;
  }).join('');
  box.onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    const star = e.target.closest('[data-set]');
    if (del) {
      const [championId, role] = del.dataset.del.split(':');
      await run(api.removePool({ championId: Number(championId), role }));
    } else if (star) {
      const [championId, role] = star.dataset.set.split(':');
      await run(api.upsertPool({ championId: Number(championId), role, comfort: Number(star.dataset.v) }));
    }
  };
  renderGrid();
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
      <button class="btn ghost" id="leave">Leave team</button>
      <button class="btn ghost" id="out">Sign out</button>
    </div>
    <div class="members">
      ${S.members.map((m) => {
        const ps = (S.pickScores || {})[m.id];
        const owner = t?.owner_id === m.id;
        return `
          <div class="member">
            <div class="top">
              <span class="nick">${esc(m.nickname)}${m.id === S.me.id ? ' (you)' : ''}${owner ? ' <span class="badge owner">Owner</span>' : ''}</span>
              <span class="muted">${esc(ROLE_NAME[m.main_role] || '')}</span>
            </div>
            <div class="muted small">${m.riot_id ? esc(m.riot_id) : 'LoL account not linked yet'}</div>
            <div class="pick-avg" title="Average score of this player's picks at lock time, over all recorded drafts">
              ${ps
                ? `<b class="sc sc-${tierOf(ps.avg)}">${ps.avg}</b><span class="muted small">avg pick score · ${ps.picks} pick${ps.picks === 1 ? '' : 's'}</span>`
                : '<span class="muted small">No recorded picks yet</span>'}
            </div>
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
    $view.innerHTML = `<div class="empty-state"><h2>No saved drafts yet</h2><p>Drafts and match results show up here once someone on the team enters champ select.</p></div>`;
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
