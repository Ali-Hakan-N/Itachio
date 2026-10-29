// The app's core: listens to LCU events, keeps the draft state, saves history
// to Supabase and publishes updates to the UI.
// Independent of Electron; tests run it with a mock LCU and a fake data layer.

const { EventEmitter } = require('node:events');
const { normalizeSession } = require('./champselect');
const { parseEndOfGame } = require('./endofgame');
// The UI's scoring engine also runs here, to record each pick's score
globalThis.Recommend = globalThis.Recommend || require('../renderer/recommend');
const { Engine } = require('../renderer/model');

const PRE_GAME_PHASES = new Set(['None', 'Lobby', 'Matchmaking', 'ReadyCheck']);

class AppCore extends EventEmitter {
  constructor({ lcu, data, log = console }) {
    super();
    this.lcu = lcu;
    this.data = data;
    this.log = log;
    this.state = {
      me: null,
      team: null,
      members: [],
      pools: [],
      champions: [],
      patch: null,
      stats: { meta: [], synergy: [], matchup: [] },
      model: null, // learned win model; when missing the older scoring is used
      lcu: { connected: false, phase: 'None', summoner: null },
      draft: null,
      pickScores: {}, // average score of each player's picks
      pickable: null, // champions you can pick in champ select (owned + free rotation)
    };
    this.current = null; // { rowId, gameId, status } - database row of the current draft
    this.lastGame = null; // to link end-of-game data to the draft
    this.savedKeys = new Set();
    this.savedEog = new Set();
    this.queue = Promise.resolve(); // serializes database writes
    this.championIds = new Set();
    this.#attachLcu();
  }

  // ---------------- State ----------------
  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }
  #emit(partial) {
    Object.assign(this.state, partial);
    this.emit('update', JSON.parse(JSON.stringify(partial)));
  }
  #enqueue(fn) {
    this.queue = this.queue.then(fn).catch((err) => this.log.error('[save]', err.message || err));
    return this.queue;
  }

  async loadUserData() {
    const me = await this.data.loadMe();
    const { patch, champions } = await this.data.loadChampions();
    const [stats, model] = await Promise.all([
      this.data.loadStats(),
      this.data.loadModel().catch((err) => {
        this.log.error('[model]', err.message);
        return null;
      }),
    ]);
    this.championIds = new Set(champions.map((c) => c.id));
    this.#emit({ me, patch, champions, stats, model });
    await this.refreshTeam();
    await this.#linkRiotAccount();
  }

  async refreshTeam() {
    const me = await this.data.loadMe();
    const { team, members, pools, pickScores } = await this.data.loadTeam(me?.team_id);
    this.#emit({ me, team, members, pools, pickScores: pickScores || {} });
    this.data.subscribeTeam?.(team?.id, () => this.#debouncedTeamRefresh(), me?.id);
  }
  #debouncedTeamRefresh() {
    clearTimeout(this._teamTimer);
    this._teamTimer = setTimeout(() => this.refreshTeam().catch((e) => this.log.error(e)), 300);
  }

  clearUserData() {
    this.data.unsubscribe?.();
    this.#emit({ me: null, team: null, members: [], pools: [] });
  }

  // ---------------- LCU ----------------
  #attachLcu() {
    this.lcu.on('status', ({ connected }) => this.#onLcuStatus(connected));
    this.lcu.on('event', (ev) => this.#onLcuEvent(ev));
  }

  async #onLcuStatus(connected) {
    if (!connected) {
      this.#emit({ lcu: { connected: false, phase: 'None', summoner: null }, draft: null });
      return;
    }
    try {
      const summoner = await this.lcu.get('/lol-summoner/v1/current-summoner');
      const phase = (await this.lcu.get('/lol-gameflow/v1/gameflow-phase')) || 'None';
      this.#emit({
        lcu: {
          connected: true,
          phase,
          summoner: summoner
            ? { puuid: summoner.puuid, riotId: summoner.gameName ? `${summoner.gameName}#${summoner.tagLine}` : summoner.displayName }
            : null,
        },
      });
      await this.#linkRiotAccount();
      if (phase === 'ChampSelect') {
        const session = await this.lcu.get('/lol-champ-select/v1/session');
        if (session) this.#onSession(session);
      }
    } catch (err) {
      this.log.error('[lcu]', err.message);
      this.#emit({ lcu: { ...this.state.lcu, connected: true } });
    }
  }

  async #linkRiotAccount() {
    const s = this.state.lcu.summoner;
    const me = this.state.me;
    if (!s?.puuid || !me) return;
    try {
      const updated = await this.data.linkRiotAccount(me, { puuid: s.puuid, riotId: s.riotId });
      if (updated && updated !== me) this.#emit({ me: updated });
    } catch (err) {
      this.log.error('[account link]', err.message);
    }
  }

  #onLcuEvent(ev) {
    switch (ev.uri) {
      case '/lol-gameflow/v1/gameflow-phase':
        return this.#onPhase(ev.data);
      case '/lol-champ-select/v1/session':
        if (ev.eventType === 'Delete') return this.#emit({ draft: null, pickable: null });
        return this.#onSession(ev.data);
      case '/lol-end-of-game/v1/eog-stats-block':
        return this.#onEndOfGame(ev.data);
      default:
    }
  }

  #onPhase(phase) {
    const prev = this.state.lcu.phase;
    this.#emit({ lcu: { ...this.state.lcu, phase } });
    const cur = this.current;

    if ((phase === 'GameStart' || phase === 'InProgress') && cur && cur.status === 'live') {
      cur.status = 'played';
      this.lastGame = { ...cur };
      this.#enqueue(() => this.data.updateDraft(cur.rowId, { status: 'played' }));
    }

    if (prev === 'ChampSelect' && PRE_GAME_PHASES.has(phase)) {
      // Champ select ended without a game: dodge
      if (cur && cur.status === 'live') {
        cur.status = 'dodged';
        this.#enqueue(() => this.data.updateDraft(cur.rowId, { status: 'dodged', ended_at: new Date().toISOString() }));
      }
      this.current = null;
      this.savedKeys.clear();
      this.#emit({ draft: null, pickable: null });
    }

    if (phase === 'EndOfGame') {
      // Ask for end-of-game data too, in case the event was missed
      this.lcu
        .get('/lol-end-of-game/v1/eog-stats-block')
        .then((block) => block && this.#onEndOfGame(block))
        .catch(() => {});
    }
  }

  #onSession(raw) {
    const draft = normalizeSession(raw);
    const isNew = !this.state.draft || this.state.draft.gameId !== draft.gameId;
    this.#emit(isNew ? { draft, pickable: null } : { draft });
    if (isNew) {
      this.#loadPickable(draft.gameId);
      const mine = (raw.actions || []).flat().filter((a) => a.actorCellId === draft.localCellId);
      this.log.info?.('champ select', JSON.stringify({
        gameId: draft.gameId, localCellId: draft.localCellId, myPickActionId: draft.myPickActionId,
        position: draft.ally.find((p) => p.isLocal)?.position || '',
        myActions: mine.map((a) => ({ id: a.id, type: a.type, inProgress: a.isInProgress, completed: a.completed })),
      }));
    }
    this.#enqueue(() => this.#persistDraft(draft));
  }

  // Sets a hover (or pick intent before our turn) in the client, for our pick or our
  // ban. Locking stays in the client.
  async hoverChampion(championId, kind = 'pick') {
    const actionId = kind === 'ban' ? this.state.draft?.myBanActionId : this.state.draft?.myPickActionId;
    if (!actionId) throw new Error(kind === 'ban' ? 'No ban to set right now' : 'No pick to set right now');
    await this.lcu.request('PATCH', `/lol-champ-select/v1/session/actions/${actionId}`, { championId });
  }

  // Pickable champions do not change during champ select; fetched once per session.
  // Banned/picked ones are included too; the recommendation engine filters them.
  #loadPickable(gameId) {
    this.lcu
      .get('/lol-champ-select/v1/pickable-champion-ids')
      .then((ids) => {
        if (Array.isArray(ids) && ids.length && this.state.draft?.gameId === gameId) this.#emit({ pickable: ids });
      })
      .catch((err) => this.log.error('[pickable champions]', err.message));
  }

  async #persistDraft(draft) {
    const { me } = this.state;
    if (!me?.team_id) return;

    if (!this.current || (draft.gameId && this.current.gameId !== draft.gameId)) {
      const row = await this.data.ensureDraft({
        teamId: me.team_id,
        playerId: me.id,
        gameId: draft.gameId,
        ourSide: draft.ourSide,
        patch: this.state.patch,
      });
      this.current = { rowId: row.id, gameId: draft.gameId, status: row.status || 'live' };
      this.savedKeys.clear();
    }

    const byPuuid = new Map(this.state.members.filter((m) => m.puuid).map((m) => [m.puuid, m.id]));
    const cellInfo = new Map();
    for (const p of draft.ally) cellInfo.set(p.cellId, { position: p.position, playerId: byPuuid.get(p.puuid) || null });
    for (const p of draft.enemy) cellInfo.set(p.cellId, { position: p.position, playerId: null });

    const rows = [];
    draft.completed.forEach((a, i) => {
      const key = `${a.side}:${a.kind}:${a.seq}`;
      if (this.savedKeys.has(key) || !this.championIds.has(a.championId)) return;
      const info = cellInfo.get(a.actorCellId) || {};
      rows.push({
        draft_id: this.current.rowId,
        side: a.side,
        kind: a.kind,
        seq: a.seq,
        champion_id: a.championId,
        role: a.kind === 'pick' ? info.position || null : null,
        player_id: a.kind === 'pick' ? info.playerId || null : null,
        score: a.kind === 'pick' && a.side === 'ally' && info.playerId ? this.#pickScore(draft, i, cellInfo) : null,
      });
    });
    if (!rows.length) return;
    await this.data.addDraftActions(rows);
    for (const r of rows) this.savedKeys.add(`${r.side}:${r.kind}:${r.seq}`);
  }

  // Score of a pick at the moment it was locked: against the picks locked before it
  #pickScore(draft, index, cellInfo) {
    const a = draft.completed[index];
    const before = draft.completed.slice(0, index).filter((x) => x.kind === 'pick');
    const asPick = (x) => ({ championId: x.championId, position: (cellInfo.get(x.actorCellId) || {}).position || '' });
    try {
      const ev = Engine.evaluate({
        stats: this.state.stats,
        model: this.state.model,
        championId: a.championId,
        role: (cellInfo.get(a.actorCellId) || {}).position || '',
        allies: before.filter((x) => x.side === a.side).map(asPick),
        enemies: before.filter((x) => x.side !== a.side).map(asPick),
      });
      return ev ? ev.score : null;
    } catch (err) {
      this.log.error('[pick score]', err.message);
      return null;
    }
  }

  #onEndOfGame(block) {
    const res = parseEndOfGame(block);
    if (!res || this.savedEog.has(res.gameId)) return;
    this.savedEog.add(res.gameId);
    this.#enqueue(async () => {
      const { me } = this.state;
      if (!me?.team_id) return;
      let draftId = null;
      for (const g of [this.lastGame, this.current]) if (g && g.gameId === res.gameId) draftId = g.rowId;
      if (!draftId) draftId = (await this.data.findDraftByGame(me.team_id, res.gameId))?.id || null;

      await this.data.saveMatchResult({
        team_id: me.team_id,
        draft_id: draftId,
        game_id: res.gameId,
        player_id: me.id,
        champion_id: this.championIds.has(res.championId) ? res.championId : null,
        win: res.win,
        kills: res.kills,
        deaths: res.deaths,
        assists: res.assists,
        cs: res.cs,
        gold: res.gold,
        damage: res.damage,
        vision: res.vision,
        duration_s: res.durationS,
        raw: res.raw,
      });
      if (draftId) {
        await this.data.updateDraft(draftId, {
          status: 'finished',
          result: res.win === null ? null : res.win ? 'win' : 'loss',
          ended_at: new Date().toISOString(),
        });
      }
      this.current = null;
      this.savedKeys.clear();
      this.emit('saved', { type: 'match', gameId: res.gameId });
    });
  }
}

module.exports = { AppCore };
