-- =====================================================================
-- Recommendation engine data
-- Replaces the empty meta_scores / matchups / synergies tables from 0001 with
-- the three tables the engine reads directly. Only the local collector writes
-- them (collector/, with service_role). The app only reads.
--
-- Every row belongs to a source. Each collector run rewrites that source's rows.
-- =====================================================================

drop table if exists public.meta_scores;
drop table if exists public.matchups;
drop table if exists public.synergies;

-- A champion's overall meta score in a role
create table public.champion_meta (
  champion_id  integer not null references public.champions(id) on delete cascade,
  role         text    not null check (role in ('top','jungle','middle','bottom','utility')),
  source       text    not null,
  patch        text,
  score        numeric not null check (score between 0 and 100),
  tier         text,
  win_rate     numeric,
  pick_rate    numeric,
  ban_rate     numeric,
  games        integer,
  collected_at timestamptz not null default now(),
  primary key (champion_id, role, source)
);

-- Team synergy: how well champion_id (in this role) does with ally_id on its team
--   strength 0..1  (0 = no effect, 1 = very strong synergy)
create table public.champion_synergy (
  champion_id  integer not null references public.champions(id) on delete cascade,
  role         text    not null check (role in ('top','jungle','middle','bottom','utility')),
  ally_id      integer not null references public.champions(id) on delete cascade,
  source       text    not null,
  strength     numeric not null check (strength between 0 and 1),
  win_rate     numeric,
  games        integer,
  collected_at timestamptz not null default now(),
  primary key (champion_id, role, ally_id, source)
);

-- Matchup: champion_id (in this role) against opponent_id
--   strength -1..1  (+ = Strong Against, - = Weak Against)
create table public.champion_matchup (
  champion_id  integer not null references public.champions(id) on delete cascade,
  role         text    not null check (role in ('top','jungle','middle','bottom','utility')),
  opponent_id  integer not null references public.champions(id) on delete cascade,
  source       text    not null,
  strength     numeric not null check (strength between -1 and 1),
  win_rate     numeric,
  games        integer,
  collected_at timestamptz not null default now(),
  primary key (champion_id, role, opponent_id, source)
);
create index champion_synergy_ally_idx  on public.champion_synergy(ally_id);
create index champion_matchup_opp_idx   on public.champion_matchup(opponent_id);

-- Every collector run: when, which source, how many rows, errors
create table public.collector_runs (
  id          bigint generated always as identity primary key,
  source      text not null,
  status      text not null default 'running' check (status in ('running','ok','error')),
  stats       jsonb,
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.champion_meta    enable row level security;
alter table public.champion_synergy enable row level security;
alter table public.champion_matchup enable row level security;
alter table public.collector_runs   enable row level security;

revoke all on public.champion_meta, public.champion_synergy,
  public.champion_matchup, public.collector_runs from anon;
grant select on public.champion_meta, public.champion_synergy,
  public.champion_matchup, public.collector_runs to authenticated;
revoke insert, update, delete on public.champion_meta, public.champion_synergy,
  public.champion_matchup, public.collector_runs from authenticated;

create policy "read" on public.champion_meta    for select to authenticated using (true);
create policy "read" on public.champion_synergy for select to authenticated using (true);
create policy "read" on public.champion_matchup for select to authenticated using (true);
create policy "read" on public.collector_runs   for select to authenticated using (true);
