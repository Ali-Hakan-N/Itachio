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

function check({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

class DataStore {
  constructor({ url, key, storageFile }) {
    this.client = createClient(url, key, {
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
  async saveProfile({ nickname, mainRole }) {
    const user = await this.getUser();
    const me = await this.loadMe();
    const fields = { nickname: nickname.trim(), main_role: mainRole || null };
    if (me) {
      return check(await this.client.from('players').update(fields).eq('id', me.id).select().single());
    }
    return check(await this.client.from('players').insert({ ...fields, user_id: user.id }).select().single());
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
  async loadTeam(teamId) {
    if (!teamId) return { team: null, members: [], pools: [] };
    const team = check(await this.client.from('teams').select('*').eq('id', teamId).maybeSingle());
    const members = check(
      await this.client.from('players').select('id,nickname,main_role,puuid,riot_id').eq('team_id', teamId).order('created_at'),
    );
    const ids = members.map((m) => m.id);
    const pools = ids.length
      ? check(await this.client.from('player_pools').select('*').in('player_id', ids))
      : [];
    return { team, members, pools };
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
      all('champion_synergy', 'champion_id,role,ally_id,strength,games', ['champion_id', 'role', 'ally_id', 'source']),
      all('champion_matchup', 'champion_id,role,opponent_id,opponent_role,strength,games', ['champion_id', 'role', 'opponent_id', 'opponent_role', 'source']),
    ]);
    return { meta, synergy, matchup };
  }

  // Newest learned win model (collector/src/model), one JSON document
  async loadModel() {
    const row = check(
      await this.client.from('model_snapshots').select('data').order('id', { ascending: false }).limit(1).maybeSingle(),
    );
    return row?.data || null;
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
  async ensureDraft({ teamId, playerId, gameId, ourSide, patch, queueId }) {
    const row = {
      team_id: teamId,
      lcu_game_id: gameId,
      our_side: ourSide,
      patch,
      queue_id: queueId ?? null,
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
  async listHistory(teamId, limit = 30) {
    return check(
      await this.client
        .from('drafts')
        .select('id,started_at,our_side,status,result,patch,draft_actions(side,kind,seq,champion_id,role,player_id)')
        .eq('team_id', teamId)
        .order('started_at', { ascending: false })
        .limit(limit),
    );
  }

  // ---------- Live updates ----------
  subscribeTeam(teamId, onChange) {
    this.unsubscribe();
    if (!teamId) return;
    this.channel = this.client
      .channel(`team-${teamId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'player_pools' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `team_id=eq.${teamId}` }, onChange)
      .subscribe();
  }
  unsubscribe() {
    if (this.channel) this.client.removeChannel(this.channel);
    this.channel = null;
  }
}

module.exports = { DataStore };
