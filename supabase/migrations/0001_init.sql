-- =====================================================================
-- LoL Draft Picker - initial schema
-- Run once (supabase db push, or paste into the SQL Editor).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Shared game data (everyone reads, only the server side writes)
-- ---------------------------------------------------------------------

-- Small key/value table: things like the current patch
create table public.app_meta (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- Champion list from Data Dragon
create table public.champions (
  id         integer primary key,          -- Riot numeric key (Ahri = 103)
  slug       text not null unique,         -- Data Dragon id ("Ahri", "MonkeyKing")
  name       text not null,
  title      text,
  tags       text[] not null default '{}', -- Mage, Assassin, Tank...
  image      text not null,                -- "Ahri.png"
  patch      text not null,
  updated_at timestamptz not null default now()
);

-- Placeholder strategy tables (replaced in 0002_meta_engine.sql).
-- Each row carries its patch and source, so sources can be swapped or compared.
create table public.meta_scores (
  champion_id  integer not null references public.champions(id) on delete cascade,
  role         text    not null,
  patch        text    not null,
  source       text    not null,           -- 'scrape:siteX', 'riot-api', 'model-v1'...
  score        numeric,                    -- source's normalized score (0-100)
  tier         text,
  win_rate     numeric,
  pick_rate    numeric,
  ban_rate     numeric,
  games        integer,
  collected_at timestamptz not null default now(),
  primary key (champion_id, role, patch, source)
);

create table public.matchups (
  champion_id  integer not null references public.champions(id) on delete cascade,
  opponent_id  integer not null references public.champions(id) on delete cascade,
  role         text    not null,
  patch        text    not null,
  source       text    not null,
  score        numeric,                    -- + : champion_id has the edge
  win_rate     numeric,
  games        integer,
  collected_at timestamptz not null default now(),
  primary key (champion_id, opponent_id, role, patch, source)
);

create table public.synergies (
  champion_id  integer not null references public.champions(id) on delete cascade,
  ally_id      integer not null references public.champions(id) on delete cascade,
  patch        text    not null,
  source       text    not null,
  score        numeric,
  win_rate     numeric,
  games        integer,
  collected_at timestamptz not null default now(),
  primary key (champion_id, ally_id, patch, source)
);

-- ---------------------------------------------------------------------
-- 2) Teams and players
-- ---------------------------------------------------------------------

create table public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 2 and 40),
  join_code  text not null unique
             default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_at timestamptz not null default now()
);

create table public.players (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique references auth.users(id) on delete cascade,
  team_id    uuid references public.teams(id) on delete set null,
  nickname   text not null check (char_length(nickname) between 2 and 32),
  main_role  text check (main_role in ('top','jungle','middle','bottom','utility')),
  puuid      text unique,                  -- LoL account (filled in by the app)
  riot_id    text,                         -- "Name#TAG"
  created_at timestamptz not null default now()
);
create index players_team_idx on public.players(team_id);

-- A player's champion pool
create table public.player_pools (
  player_id   uuid     not null references public.players(id) on delete cascade,
  champion_id integer  not null references public.champions(id) on delete cascade,
  role        text     not null check (role in ('top','jungle','middle','bottom','utility')),
  comfort     smallint not null default 3 check (comfort between 1 and 5),
  notes       text,
  updated_at  timestamptz not null default now(),
  primary key (player_id, champion_id, role)
);

-- ---------------------------------------------------------------------
-- 3) Draft history and match results (your own data set)
-- ---------------------------------------------------------------------

create table public.drafts (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  lcu_game_id bigint,                      -- one row even if two apps record the same game
  queue_id    integer,
  our_side    text check (our_side in ('blue','red')),
  source      text not null default 'lcu' check (source in ('lcu','manual')),
  patch       text,
  status      text not null default 'live'
              check (status in ('live','played','finished','dodged')),
  result      text check (result in ('win','loss')),
  created_by  uuid references public.players(id) on delete set null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  unique (team_id, lcu_game_id)
);
create index drafts_team_idx on public.drafts(team_id, started_at desc);

create table public.draft_actions (
  id          bigint generated always as identity primary key,
  draft_id    uuid    not null references public.drafts(id) on delete cascade,
  side        text    not null check (side in ('ally','enemy')),
  kind        text    not null check (kind in ('ban','pick')),
  seq         integer not null,            -- that side's nth ban/pick
  champion_id integer not null references public.champions(id),
  role        text,
  player_id   uuid references public.players(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (draft_id, side, kind, seq)
);

create table public.match_results (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  draft_id    uuid references public.drafts(id) on delete set null,
  game_id     bigint not null,
  player_id   uuid not null references public.players(id) on delete cascade,
  champion_id integer references public.champions(id),
  win         boolean,
  kills       integer,
  deaths      integer,
  assists     integer,
  cs          integer,
  gold        integer,
  damage      integer,
  vision      integer,
  duration_s  integer,
  raw         jsonb,                       -- raw LCU data, for reprocessing later
  created_at  timestamptz not null default now(),
  unique (game_id, player_id)
);
create index match_results_team_idx on public.match_results(team_id, created_at desc);

-- ---------------------------------------------------------------------
-- 4) Helper functions
-- ---------------------------------------------------------------------

create or replace function public.my_player_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.players where user_id = auth.uid()
$$;

create or replace function public.my_team_id()
returns uuid language sql stable security definer set search_path = public as $$
  select team_id from public.players where user_id = auth.uid()
$$;

-- Create a team and put the caller in it
create or replace function public.create_team(p_name text)
returns public.teams language plpgsql security definer set search_path = public as $$
declare t public.teams;
begin
  if public.my_player_id() is null then
    raise exception 'Create your player profile first';
  end if;
  insert into public.teams(name) values (trim(p_name)) returning * into t;
  update public.players set team_id = t.id where user_id = auth.uid();
  return t;
end $$;

-- Join a team with an invite code
create or replace function public.join_team(p_code text)
returns public.teams language plpgsql security definer set search_path = public as $$
declare t public.teams;
begin
  if public.my_player_id() is null then
    raise exception 'Create your player profile first';
  end if;
  select * into t from public.teams where join_code = upper(trim(p_code));
  if t.id is null then
    raise exception 'Invalid team code';
  end if;
  update public.players set team_id = t.id where user_id = auth.uid();
  return t;
end $$;

-- Leave the team
create or replace function public.leave_team()
returns void language sql security definer set search_path = public as $$
  update public.players set team_id = null where user_id = auth.uid()
$$;

revoke all on function public.create_team(text), public.join_team(text),
  public.leave_team(), public.my_player_id(), public.my_team_id() from public, anon;
grant execute on function public.create_team(text), public.join_team(text),
  public.leave_team(), public.my_player_id(), public.my_team_id() to authenticated;

-- ---------------------------------------------------------------------
-- 5) Grants and row level security
-- ---------------------------------------------------------------------

alter table public.app_meta      enable row level security;
alter table public.champions     enable row level security;
alter table public.meta_scores   enable row level security;
alter table public.matchups      enable row level security;
alter table public.synergies     enable row level security;
alter table public.teams         enable row level security;
alter table public.players       enable row level security;
alter table public.player_pools  enable row level security;
alter table public.drafts        enable row level security;
alter table public.draft_actions enable row level security;
alter table public.match_results enable row level security;

-- Signed-out users can access nothing
revoke all on all tables in schema public from anon;

-- Shared game data: every signed-in user reads; only service_role writes
-- (cron / Edge Function / collector), and it bypasses RLS anyway.
grant select on public.app_meta, public.champions, public.meta_scores,
  public.matchups, public.synergies to authenticated;
revoke insert, update, delete on public.app_meta, public.champions,
  public.meta_scores, public.matchups, public.synergies from authenticated;

create policy "read" on public.app_meta    for select to authenticated using (true);
create policy "read" on public.champions   for select to authenticated using (true);
create policy "read" on public.meta_scores for select to authenticated using (true);
create policy "read" on public.matchups    for select to authenticated using (true);
create policy "read" on public.synergies   for select to authenticated using (true);

-- Teams: you only see your own team. Create/join go through functions.
grant select on public.teams to authenticated;
revoke insert, update, delete on public.teams from authenticated;
create policy "own team" on public.teams for select to authenticated
  using (id = public.my_team_id());

-- Players: you see your teammates and edit only your own profile.
-- team_id cannot be changed directly (only via create/join functions).
revoke insert, update, delete on public.players from authenticated;
grant select on public.players to authenticated;
grant insert (user_id, nickname, main_role, puuid, riot_id) on public.players to authenticated;
grant update (nickname, main_role, puuid, riot_id) on public.players to authenticated;

create policy "see self and team" on public.players for select to authenticated
  using (user_id = auth.uid() or (team_id is not null and team_id = public.my_team_id()));
create policy "create self" on public.players for insert to authenticated
  with check (user_id = auth.uid());
create policy "update self" on public.players for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Pools: you see the whole team's pools and edit only your own.
grant select, insert, update, delete on public.player_pools to authenticated;
create policy "see team pools" on public.player_pools for select to authenticated
  using (exists (select 1 from public.players p
                 where p.id = player_id
                   and (p.user_id = auth.uid() or p.team_id = public.my_team_id())));
create policy "insert own" on public.player_pools for insert to authenticated
  with check (player_id = public.my_player_id());
create policy "update own" on public.player_pools for update to authenticated
  using (player_id = public.my_player_id()) with check (player_id = public.my_player_id());
create policy "delete own" on public.player_pools for delete to authenticated
  using (player_id = public.my_player_id());

-- Drafts and match results: read/write within the team
grant select, insert, update on public.drafts to authenticated;
create policy "team read"   on public.drafts for select to authenticated
  using (team_id = public.my_team_id());
create policy "team insert" on public.drafts for insert to authenticated
  with check (team_id = public.my_team_id());
create policy "team update" on public.drafts for update to authenticated
  using (team_id = public.my_team_id()) with check (team_id = public.my_team_id());

grant select, insert on public.draft_actions to authenticated;
create policy "team read" on public.draft_actions for select to authenticated
  using (exists (select 1 from public.drafts d
                 where d.id = draft_id and d.team_id = public.my_team_id()));
create policy "team insert" on public.draft_actions for insert to authenticated
  with check (exists (select 1 from public.drafts d
                      where d.id = draft_id and d.team_id = public.my_team_id()));

grant select, insert on public.match_results to authenticated;
create policy "team read" on public.match_results for select to authenticated
  using (team_id = public.my_team_id());
create policy "insert own" on public.match_results for insert to authenticated
  with check (team_id = public.my_team_id() and player_id = public.my_player_id());

-- ---------------------------------------------------------------------
-- 6) Realtime: when someone edits their pool, teammates' apps update
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.player_pools;
alter publication supabase_realtime add table public.players;
