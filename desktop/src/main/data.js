// All Supabase access lives here. The UI never talks to Supabase directly;
// the main process reads and writes through this class.

const fs = require('node:fs');
const { createClient } = require('@supabase/supabase-js');

function fileStorage(file) {
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const write = (obj) => {
    try {
      fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
    } catch {
      /* if the session cannot be saved, the user signs in again next launch */
    }
  };
  return {
    getItem: (k) => read()[k] ?? null,
    setItem: (k, v) => write({ ...read(), [k]: v }),
    removeItem: (k) => {
      const o = read();
      delete o[k];
      write(o);
    },
  };
}

// The personal layer (collector/src/players, from the players' ranked games). Set to
// false to leave it out of the scores.
const PLAYER_STATS = true;

function check({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

class DataStore {
  constructor({ url, key, storageFile, client }) {
    this.client = client || createClient(url, key, {
      auth: { storage: fileStorage(storageFile), persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    this.channel = null;
  }

  // ---------- Session ----------
  async getUser() {
    const { data } = await this.client.auth.getSession();
    return data.session?.user ?? null;
  }
  async signIn(email, password) {
    check(await this.client.auth.signInWithPassword({ email, password }));
  }
  async signUp(email, password) {
    const data = check(await this.client.auth.signUp({ email, password }));
    return { needsConfirmation: !data.session };
  }
  async requestPasswordReset(email, redirectTo) {
    check(await this.client.auth.resetPasswordForEmail(email, { redirectTo }));
  }
  async completePasswordRecovery(callbackUrl) {
    const url = new URL(callbackUrl);
    if (url.protocol !== 'itachio:' || url.hostname !== 'auth' || url.pathname !== '/callback') {
      throw new Error('Invalid password recovery link');
    }
    const code = url.searchParams.get('code');
    if (code) {
      check(await this.client.auth.exchangeCodeForSession(code));
      return;
    }
    const tokens = new URLSearchParams(url.hash.slice(1));
    const access_token = tokens.get('access_token');
    const refresh_token = tokens.get('refresh_token');
    if (tokens.get('type') !== 'recovery' || !access_token || !refresh_token) {
      throw new Error('Invalid password recovery link');
    }
    check(await this.client.auth.setSession({ access_token, refresh_token }));
  }
  async updatePassword(password) {
    check(await this.client.auth.updateUser({ password }));
  }
  async signOut() {
    this.unsubscribe();
    await this.client.auth.signOut();
  }

  // ---------- Profile and team ----------
  async loadMe() {
    const user = await this.getUser();
    if (!user) return null;
    return check(await this.client.from('players').select('*').eq('user_id', user.id).maybeSingle());
  }
  async saveProfile({ nickname }) {
    const user = await this.getUser();
    const me = await this.loadMe();
    const fields = { nickname: nickname.trim() };
    if (me) {
      return check(await this.client.from('players').update(fields).eq('id', me.id).select().single());
    }
    return check(await this.client.from('players').insert({ ...fields, user_id: user.id }).select().single());
  }
  // Roles the player plays: any number of them
  async saveRoles(me, roles) {
    return check(await this.client.from('players').update({ roles }).eq('id', me.id).select().single());
  }
  // Hides the player's games so far from their History tab
  async clearHistory(me) {
    return check(await this.client.from('players').update({ history_cleared_at: new Date().toISOString() }).eq('id', me.id).select().single());
  }
  async linkRiotAccount(me, { puuid, riotId }) {
    if (!me || !puuid || (me.puuid === puuid && me.riot_id === riotId)) return me;
    return check(
      await this.client.from('players').update({ puuid, riot_id: riotId }).eq('id', me.id).select().single(),
    );
  }
  async createTeam(name) {
    return check(await this.client.rpc('create_team', { p_name: name }));
  }
  async joinTeam(code) {
    return check(await this.client.rpc('join_team', { p_code: code }));
  }
  async leaveTeam() {
    check(await this.client.rpc('leave_team'));
  }
  // Only the team owner may do this; the database checks it
  async kickMember(playerId) {
    check(await this.client.rpc('kick_member', { p_player: playerId }));
  }
  async loadTeam(teamId) {
    if (!teamId) return { team: null, members: [], pools: [] };
    const team = check(await this.client.from('teams').select('*').eq('id', teamId).maybeSingle());
    const members = check(
      await this.client.from('players').select('id,nickname,puuid,riot_id,roles,history_cleared_at').eq('team_id', teamId).order('created_at'),
    );
    const ids = members.map((m) => m.id);
    const pools = ids.length
      ? check(await this.client.from('player_pools').select('*').in('player_id', ids))
      : [];
    return { team, members, pools, playerStats: PLAYER_STATS ? await this.loadPlayerStats(ids) : {} };
  }

  // How each player does on each champion (collector/src/players), per source (season:
  // their ranked games of the season, history: those of the patch, team: those with
  // team-mates, per line-up of team members on their side):
  // { playerId: { season|history: stats, team: { "<sorted player ids>": stats } } }
  // stats: { byKey: { "<champ>:<role>": { delta, games, wins, early, late } }, unplayed }
  async loadPlayerStats(playerIds) {
    if (!playerIds.length) return {};
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const page = check(
        await this.client.from('player_champion_stats').select('player_id,champion_id,role,source,lineup,games,wins,early,late,delta')
          .in('player_id', playerIds).order('player_id').order('champion_id').order('role').order('source').order('lineup').range(from, from + 999),
      );
      rows.push(...page);
      if (page.length < 1000) break;
    }
    const out = {};
    for (const r of rows) {
      const own = (out[r.player_id] ||= {});
      const p = r.source === 'team'
        ? ((own.team ||= {})[r.lineup] ||= { byKey: {}, unplayed: 0 })
        : (own[r.source] ||= { byKey: {}, unplayed: 0 });
      if (r.champion_id === 0) p.unplayed = Number(r.delta);
      else {
        p.byKey[`${r.champion_id}:${r.role}`] = {
          delta: Number(r.delta), games: r.games, wins: r.wins, early: Number(r.early), late: Number(r.late),
        };
      }
    }
    return out;
  }

  // ---------- Game data ----------
  async loadChampions() {
    const meta = check(await this.client.from('app_meta').select('value').eq('key', 'current_patch').maybeSingle());
    const champions = check(await this.client.from('champions').select('id,slug,name,title,tags,image').order('name'));
    return { patch: meta?.value || null, champions };
  }
  // Recommendation engine data. Supabase returns at most 1000 rows per request, so it is paged.
  async loadStats() {
    // Ordered by the full primary key so pages do not shift
    const all = async (table, columns, order) => {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        let q = this.client.from(table).select(columns);
        for (const col of order) q = q.order(col);
        const page = check(await q.range(from, from + 999));
        rows.push(...page);
        if (page.length < 1000) return rows;
      }
    };
    const [meta, synergy, matchup] = await Promise.all([
      all('champion_meta', 'champion_id,role,score,tier,games,source', ['champion_id', 'role', 'source']),
      all('champion_synergy', 'champion_id,role,ally_id,strength,games,source', ['champion_id', 'role', 'ally_id', 'source']),
      all('champion_matchup', 'champion_id,role,opponent_id,opponent_role,strength,games,source', ['champion_id', 'role', 'opponent_id', 'opponent_role', 'source']),
    ]);
    return { meta, synergy, matchup };
  }

  // Runes, items and spells per champion, role and enemy damage (collector/src/model/builds.js):
  // { "<champ>:<role>:<any|ap|ad|mixed>": { runes, items, spells, games } }
  async loadBuilds() {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const page = check(
        await this.client.from('champion_builds').select('champion_id,role,bucket,games,runes,items,spells')
          .order('champion_id').order('role').order('bucket').range(from, from + 999),
      );
      rows.push(...page);
      if (page.length < 1000) break;
    }
    return Object.fromEntries(rows.map((r) => [`${r.champion_id}:${r.role}:${r.bucket}`, r]));
  }
  // Champions' magic share and the damage thresholds, to pick the build for the enemy team
  async loadDamage() {
    const row = check(await this.client.from('app_meta').select('value').eq('key', 'champion_damage').maybeSingle());
    return row ? JSON.parse(row.value) : null;
  }
  // What items are worth against kinds of enemy teams (collector/src/model/builds.js)
  async loadSituations() {
    const row = check(await this.client.from('app_meta').select('value').eq('key', 'item_situations').maybeSingle());
    return row ? JSON.parse(row.value) : null;
  }
  // Names and icons of runes and summoner spells, and item names, from Data Dragon
  async loadGameData(version) {
    if (!version) return null;
    const get = async (file) => {
      const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/${file}`);
      if (!res.ok) throw new Error(`Data Dragon ${file}: HTTP ${res.status}`);
      return res.json();
    };
    const [trees, spells, itemData] = await Promise.all([get('runesReforged.json'), get('summoner.json'), get('item.json')]);
    const perks = {};
    for (const t of trees) {
      perks[t.id] = { name: t.name, icon: t.icon };
      for (const slot of t.slots) for (const r of slot.runes) perks[r.id] = { name: r.name, icon: r.icon };
    }
    const summoner = {};
    for (const sp of Object.values(spells.data)) summoner[sp.key] = { name: sp.name, image: sp.image.full };
    const items = Object.fromEntries(Object.entries(itemData.data).map(([id, it]) => [id, it.name]));
    return { perks, summoner, items };
  }

  // Newest learned win model (collector/src/model), one JSON document, tagged with its snapshot id
  async loadModel() {
    const row = check(
      await this.client.from('model_snapshots').select('id,data').order('id', { ascending: false }).limit(1).maybeSingle(),
    );
    return row?.data ? { ...row.data, snapshotId: row.id } : null;
  }
  // Id of the newest model, a cheap check before downloading it
  async latestModelId() {
    const row = check(
      await this.client.from('model_snapshots').select('id').order('id', { ascending: false }).limit(1).maybeSingle(),
    );
    return row?.id ?? null;
  }

  // ---------- Pool ----------
  async upsertPool(playerId, { championId, role, comfort, notes }) {
    check(
      await this.client.from('player_pools').upsert(
        { player_id: playerId, champion_id: championId, role, comfort, notes: notes ?? null, updated_at: new Date().toISOString() },
        { onConflict: 'player_id,champion_id,role' },
      ),
    );
  }
  async removePool(playerId, { championId, role }) {
    check(
      await this.client.from('player_pools').delete().match({ player_id: playerId, champion_id: championId, role }),
    );
  }

  // ---------- Draft history ----------
  async ensureDraft({ teamId, playerId, gameId, ourSide, patch, queueId, platform }) {
    const row = {
      team_id: teamId,
      lcu_game_id: gameId,
      our_side: ourSide,
      patch,
      queue_id: queueId ?? null,
      platform: platform ?? null,
      source: 'lcu',
      created_by: playerId,
    };
    if (!gameId) {
      return check(await this.client.from('drafts').insert(row).select('id,status').single());
    }
    // One row even if several teammates record the same game
    check(
      await this.client.from('drafts').upsert(row, { onConflict: 'team_id,lcu_game_id', ignoreDuplicates: true }),
    );
    return check(
      await this.client.from('drafts').select('id,status').eq('team_id', teamId).eq('lcu_game_id', gameId).single(),
    );
  }
  async addDraftActions(rows) {
    if (!rows.length) return;
    check(
      await this.client.from('draft_actions').upsert(rows, { onConflict: 'draft_id,side,kind,seq', ignoreDuplicates: true }),
    );
  }
  async updateDraft(id, fields) {
    check(await this.client.from('drafts').update(fields).eq('id', id));
  }
  async findDraftByGame(teamId, gameId) {
    return check(
      await this.client.from('drafts').select('id,status').eq('team_id', teamId).eq('lcu_game_id', gameId).maybeSingle(),
    );
  }
  async saveMatchResult(row) {
    check(await this.client.from('match_results').upsert(row, { onConflict: 'game_id,player_id', ignoreDuplicates: true }));
  }
  // A player's ranked games (collector/src/players), newest first, after they last cleared
  // their history
  async listHistory(player, limit = 100) {
    let q = this.client
      .from('player_games')
      .select('match_id,started_at,queue_id,duration_s,side,role,champion_id,win,kills,deaths,assists,cs,blue,red,lineup')
      .eq('player_id', player.id);
    if (player.history_cleared_at) q = q.gt('started_at', player.history_cleared_at);
    return check(await q.order('started_at', { ascending: false }).limit(limit));
  }

  // ---------- Live updates ----------
  // playerId: our own row too, so we notice being removed from the team
  subscribeTeam(teamId, onChange, playerId) {
    this.unsubscribe();
    if (!teamId) return;
    let channel = this.client
      .channel(`team-${teamId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'player_pools' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `team_id=eq.${teamId}` }, onChange);
    if (playerId) channel = channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'players', filter: `id=eq.${playerId}` }, onChange);
    this.channel = channel.subscribe();
  }
  unsubscribe() {
    if (this.channel) this.client.removeChannel(this.channel);
    this.channel = null;
  }
}

module.exports = { DataStore };
