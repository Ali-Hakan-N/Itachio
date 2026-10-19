/* global api, Recommend */
// Arayüz. Durum main process'ten gelir (api.onState), burası sadece çizer ve istek gönderir.

const ROLES = [
  ['top', 'Üst'],
  ['jungle', 'Orman'],
  ['middle', 'Orta'],
  ['bottom', 'Alt'],
  ['utility', 'Destek'],
];
const ROLE_NAME = Object.fromEntries(ROLES);

const PHASE_TEXT = {
  None: 'Boşta',
  Lobby: 'Lobide',
  Matchmaking: 'Maç aranıyor',
  ReadyCheck: 'Maç bulundu',
  ChampSelect: 'Şampiyon seçimi',
  GameStart: 'Oyun yükleniyor',
  InProgress: 'Oyunda',
  WaitingForStats: 'İstatistikler bekleniyor',
  PreEndOfGame: 'Maç bitti',
  EndOfGame: 'Maç sonu',
};

let S = null; // main process'ten gelen durum
let tab = 'draft';
let screen = 'loading'; // loading | config | login | profile | team | main
let configError = null;
const poolUi = { search: '', role: '', selected: null, editRole: '', editComfort: 3 };

const $view = document.getElementById('view');
const $status = document.getElementById('status');
const $tabs = document.getElementById('tabs');

// ---------- yardımcılar ----------
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

// ---------- akış ----------
async function boot() {
  const init = await run(api.init());
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
  // Havuz ekranında yazı yazılırken odak kaybolmasın: sadece ilgili kısımları yenile
  if (screen !== 'main') return;
  if (tab === 'draft' && ('draft' in partial || 'pools' in partial || 'lcu' in partial || 'members' in partial)) renderMain();
  if (tab === 'team' && ('members' in partial || 'pools' in partial || 'team' in partial)) renderMain();
  if (tab === 'pool' && 'pools' in partial) renderPoolList();
});
api.onSaved((info) => {
  if (info.type === 'match') toast('Maç sonucu ve draft kaydedildi');
});

$tabs.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  for (const x of $tabs.querySelectorAll('button')) x.classList.toggle('active', x === b);
  renderMain();
});

// ---------- çizim ----------
function render() {
  $tabs.hidden = screen !== 'main';
  renderStatus();
  if (screen === 'loading') $view.innerHTML = `<div class="empty-state"><p>Yükleniyor…</p></div>`;
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
    : `<span class="dot"></span><span>League istemcisi bekleniyor</span>`;
}

function renderConfig() {
  $view.innerHTML = `
    <div class="card">
      <h2>Kurulum eksik</h2>
      <p>${esc(configError)}</p>
      <p>Uygulama klasöründeki <b>config.example.json</b> dosyasını <b>config.json</b> olarak kopyalayın,
      Supabase proje adresini ve anahtarını yazıp uygulamayı yeniden başlatın.</p>
    </div>`;
}

function renderLogin(mode = 'signin') {
  const signup = mode === 'signup';
  $view.innerHTML = `
    <form class="card" id="f">
      <h2>${signup ? 'Hesap oluştur' : 'Giriş yap'}</h2>
      <label>E-posta <input name="email" type="email" required autocomplete="email"></label>
      <label>Şifre <input name="password" type="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
      <div class="err" id="err"></div>
      <button class="btn primary" type="submit">${signup ? 'Hesap oluştur' : 'Giriş yap'}</button>
      <button class="link" type="button" id="swap">${signup ? 'Hesabın var mı? Giriş yap' : 'Hesabın yok mu? Hesap oluştur'}</button>
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
      return toast('E-postana gelen onay bağlantısına tıkla, sonra giriş yap');
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
      <h2>Oyuncu profili</h2>
      <p>Takım arkadaşların seni bu isimle görecek. LoL hesabın, istemci açıkken otomatik bağlanır.</p>
      <label>Takma ad <input name="nickname" required minlength="2" maxlength="32" value="${esc(me?.nickname || S?.lcu?.summoner?.riotId?.split('#')[0] || '')}"></label>
      <label>Ana rol <select name="mainRole">${roleOptions(me?.main_role || 'middle')}</select></label>
      <button class="btn primary" type="submit">Profili kaydet</button>
      <button class="link" type="button" id="out">Çıkış yap</button>
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
      <h2>Takımına katıl</h2>
      <p>Takım arkadaşından aldığın 8 haneli kodu gir.</p>
      <form class="row" id="join"><input name="code" placeholder="Takım kodu" required class="grow upper"><button class="btn primary">Katıl</button></form>
      <p class="gap">Takımda ilk sen misin? Takımı kur, kodu arkadaşlarınla paylaş.</p>
      <form class="row" id="create"><input name="name" placeholder="Takım adı" required minlength="2" class="grow"><button class="btn">Takımı kur</button></form>
      <button class="link" type="button" id="out">Çıkış yap</button>
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

function renderDraft() {
  clearInterval(timerHandle);
  const d = S.draft;
  if (!d) {
    const connected = S.lcu?.connected;
    $view.innerHTML = `
      <div class="empty-state">
        <h2>${connected ? 'Şampiyon seçimi bekleniyor' : 'League istemcisi kapalı'}</h2>
        <p>${connected
          ? 'Sıraya gir; champ select başladığında draft burada canlı görünür ve önerilerin hazırlanır.'
          : 'League of Legends istemcisini aç. Uygulama onu kendiliğinden bulup bağlanır.'}</p>
        ${myPool().length ? '' : '<p>Önerilerin işe yaraması için önce <b>Havuzum</b> sekmesinden şampiyonlarını ekle.</p>'}
      </div>`;
    return;
  }

  const blocked = unavailable(d);
  const turnText = !d.turn
    ? d.phase === 'FINALIZATION' ? 'Son hazırlık' : 'Bekleniyor'
    : d.isOurTurn
      ? d.turn.kind === 'ban' ? 'Ban sırası sende' : 'Pick sırası sende'
      : `${d.turn.side === 'ally' ? 'Takımın' : 'Rakip'} ${d.turn.kind === 'ban' ? 'banlıyor' : 'seçiyor'}`;

  const allyCol = sideColumn('ally', d);
  const enemyCol = sideColumn('enemy', d);
  const blueCol = d.ourSide === 'blue' ? allyCol : enemyCol;
  const redCol = d.ourSide === 'blue' ? enemyCol : allyCol;

  const local = d.ally.find((p) => p.isLocal);
  const role = local?.position || S.me?.main_role || '';
  const recs = local?.locked
    ? []
    : Recommend.recommend({ pool: myPool(), role, unavailable: blocked, meta: S.meta });

  $view.innerHTML = `
    <div class="board">
      ${blueCol}
      <section class="center">
        <div class="phasebox ${d.isOurTurn ? 'mine' : ''}">
          <div class="turn ${d.isOurTurn ? 'mine' : ''}">${esc(turnText)}</div>
          <div class="timer"><div id="tbar"></div></div>
        </div>
        <div>
          <h3 class="sub">${local?.locked ? `Seçimin: ${esc(champName(local.championId))}` : `Önerilerin${role ? ' · ' + ROLE_NAME[role] : ''}`}</h3>
          ${local?.locked ? '' : recs.length
            ? `<div class="recs">${recs.map((r) => `
                <div class="rec">${champImg(r.championId)}
                  <div><div class="name">${esc(champName(r.championId))}</div><div class="why">${esc(r.reasons.join(', '))}</div></div>
                  <div class="score">${r.score}</div>
                </div>`).join('')}</div>`
            : `<p class="note">${myPool().length ? 'Havuzundaki uygun şampiyonların hepsi banlandı veya alındı.' : 'Havuzun boş. Havuzum sekmesinden şampiyon ekle.'}</p>`}
          <p class="note gap">Puan şimdilik havuzundaki konfor ${S.meta?.length ? 've meta verisinden' : 'puanından'} geliyor; strateji motoru eklendiğinde kompozisyonu da hesaba katacak.</p>
        </div>
      </section>
      ${redCol}
    </div>`;

  // Geri sayım çubuğu
  if (d.endsAt) {
    const total = Math.max(d.endsAt - Date.now(), 1);
    const bar = document.getElementById('tbar');
    const tick = () => {
      const left = Math.max(d.endsAt - Date.now(), 0);
      if (bar) bar.style.width = `${(left / total) * 100}%`;
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

  const slots = players.map((p) => {
    const m = isAlly ? memberByPuuid(p.puuid) : null;
    const who = isAlly ? (p.isLocal ? 'Sen' : m?.nickname || 'Takım arkadaşı') : 'Rakip';
    const shown = p.locked ? p.championId : p.hoverId || 0;
    let mini = '';
    // Henüz seçmemiş takım arkadaşı için havuzundan uygun 3 şampiyon
    if (isAlly && !p.isLocal && !p.locked && m) {
      const picks = Recommend.recommend({
        pool: S.pools.filter((x) => x.player_id === m.id), role: p.position, unavailable: blocked, meta: S.meta, limit: 3,
      });
      mini = `<div class="mini">${picks.map((r) => champImg(r.championId, 's')).join('')}</div>`;
    }
    const cls = ['slot', p.isLocal ? 'me' : '', acting.has(p.cellId) ? 'acting' : '', !p.locked && shown ? 'hover' : ''].join(' ');
    return `
      <div class="${cls}">
        ${champImg(shown, 'l')}
        <div class="who">
          <div class="name">${esc(shown ? champName(shown) : '…')}</div>
          <div class="meta">${esc(who)}${p.position ? ' · ' + ROLE_NAME[p.position] : ''}${!p.locked && shown ? ' · bakıyor' : ''}</div>
        </div>
        ${mini}
      </div>`;
  });

  return `
    <section class="side ${color}">
      <div class="side-head"><h2>${isAlly ? 'Takımın' : 'Rakip'}</h2><span>${color === 'blue' ? 'Mavi taraf' : 'Kırmızı taraf'}</span></div>
      ${slots.join('')}
      <div class="bans">${bans.length ? bans.map((id) => champImg(id, 's')).join('') : '<span class="note">Ban yok</span>'}</div>
    </section>`;
}

// ---------- Havuz ----------
function renderPool() {
  $view.innerHTML = `
    <div class="pool-layout">
      <section>
        <div class="toolbar">
          <input id="q" placeholder="Şampiyon ara" value="${esc(poolUi.search)}">
        </div>
        <div class="grid" id="grid"></div>
        <div id="editor"></div>
      </section>
      <section>
        <h2 class="sub">Havuzum</h2>
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
      '<p class="note">Şampiyon listesi boş. Supabase\'de sync-ddragon fonksiyonunun bir kez çalıştırılması gerekiyor (README).</p>';
  } else renderGrid();
  renderEditor();
  renderPoolList();
}

function renderGrid() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const term = poolUi.search.trim().toLocaleLowerCase('tr');
  const inPool = new Set(myPool().map((p) => p.champion_id));
  const list = S.champions.filter((c) => !term || c.name.toLocaleLowerCase('tr').includes(term));
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
    .map((n) => `<button type="button" class="${n <= value ? 'on' : ''}" ${attr}="${n}" aria-label="Konfor ${n}">★</button>`)
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
      <button class="btn primary" id="esave">Havuza kaydet</button>
      <button class="x" id="eclose" aria-label="Kapat">×</button>
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
    toast(`${champName(poolUi.selected)} havuza kaydedildi`);
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
    box.innerHTML = '<p class="note">Henüz şampiyon eklemedin. Soldan bir şampiyona tıkla, rolünü ve ne kadar rahat oynadığını seç.</p>';
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
            <button class="x" data-del="${p.champion_id}:${p.role}" aria-label="Havuzdan çıkar">×</button>
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

// ---------- Takım ----------
function renderTeam() {
  const t = S.team;
  $view.innerHTML = `
    <div class="team-head">
      <h2>${esc(t?.name || '')}</h2>
      <span class="muted">Davet kodu</span><span class="code">${esc(t?.join_code || '')}</span>
      <button class="btn ghost" id="copy">Kodu kopyala</button>
      <span class="grow"></span>
      <button class="btn ghost" id="prof">Profili düzenle</button>
      <button class="btn ghost" id="leave">Takımdan ayrıl</button>
      <button class="btn ghost" id="out">Çıkış yap</button>
    </div>
    <div class="members">
      ${S.members.map((m) => {
        const pool = S.pools.filter((p) => p.player_id === m.id).sort((a, b) => b.comfort - a.comfort);
        return `
          <div class="member">
            <div class="top"><span class="nick">${esc(m.nickname)}${m.id === S.me.id ? ' (sen)' : ''}</span><span class="muted">${esc(ROLE_NAME[m.main_role] || '')}</span></div>
            <div class="muted small">${m.riot_id ? esc(m.riot_id) : 'LoL hesabı henüz bağlanmadı'}</div>
            <div class="icons">${pool.length ? pool.slice(0, 14).map((p) => champImg(p.champion_id, 's')).join('') : '<span class="note">Havuz boş</span>'}</div>
          </div>`;
      }).join('')}
    </div>`;
  document.getElementById('copy').onclick = () => navigator.clipboard.writeText(t.join_code).then(() => toast('Kod kopyalandı'));
  document.getElementById('out').onclick = signOut;
  document.getElementById('prof').onclick = () => {
    screen = 'profile';
    render();
  };
  document.getElementById('leave').onclick = async () => {
    if (!confirm('Takımdan ayrılmak istediğine emin misin?')) return;
    S = await run(api.leaveTeam());
    decideScreen();
  };
}

// ---------- Geçmiş ----------
async function renderHistory() {
  $view.innerHTML = '<p class="note">Yükleniyor…</p>';
  const rows = await run(api.listHistory());
  if (tab !== 'history') return;
  if (!rows.length) {
    $view.innerHTML = `<div class="empty-state"><h2>Henüz kayıtlı draft yok</h2><p>Takımdan biri champ select'e girdiğinde draft ve maç sonucu burada birikir.</p></div>`;
    return;
  }
  const picks = (r, side) =>
    r.draft_actions.filter((a) => a.side === side && a.kind === 'pick').sort((a, b) => a.seq - b.seq).map((a) => champImg(a.champion_id, 's')).join('');
  const statusText = { live: 'Devam ediyor', played: 'Oynandı', dodged: 'Dodge', finished: '' };
  $view.innerHTML = `
    <div class="hist">
      ${rows.map((r) => `
        <div class="hrow">
          <span class="muted">${new Date(r.started_at).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}</span>
          <span class="tag ${r.our_side || ''}">${r.our_side === 'red' ? 'Kırmızı' : 'Mavi'}</span>
          <span class="${r.result || 'muted'}">${r.result === 'win' ? 'Galibiyet' : r.result === 'loss' ? 'Mağlubiyet' : statusText[r.status] || ''}</span>
          <div class="icons">${picks(r, 'ally')}</div>
          <div class="icons">${picks(r, 'enemy')}</div>
        </div>`).join('')}
    </div>`;
}

boot();
