-- =====================================================================
-- Raw counters of the Riot API collector
-- The collector adds new matches every day through riot_ingest(); counters build
-- up over the patch. Scores (champion_meta / synergy / matchup) are computed from
-- them in the collector. Only service_role can access these tables.
-- =====================================================================

-- Processed matches, so no match is counted twice
create table public.riot_matches (
  match_id    text primary key,              -- "TR1_1234567890"
  platform    text not null,
  patch       text not null,                 -- "16.21"
  game_start  timestamptz,
  ingested_at timestamptz not null default now()
);
create index riot_matches_patch_idx on public.riot_matches(patch);

create table public.riot_patch_totals (
  patch   text primary key,
  matches integer not null default 0
);

-- Champion × role
create table public.riot_champ_stats (
  patch       text    not null,
  champion_id integer not null,
  role        text    not null,
  games       integer not null default 0,
  wins        integer not null default 0,
  primary key (patch, champion_id, role)
);

-- Ban count (once per match)
create table public.riot_ban_stats (
  patch       text    not null,
  champion_id integer not null,
  bans        integer not null default 0,
  primary key (patch, champion_id)
);

-- Pairs on the same team (champion_id in this role with ally_id)
create table public.riot_duo_stats (
  patch       text    not null,
  champion_id integer not null,
  role        text    not null,
  ally_id     integer not null,
  games       integer not null default 0,
  wins        integer not null default 0,
  primary key (patch, champion_id, role, ally_id)
);

-- Opponents in the same lane
create table public.riot_lane_stats (
  patch       text    not null,
  champion_id integer not null,
  role        text    not null,
  opponent_id integer not null,
  games       integer not null default 0,
  wins        integer not null default 0,
  primary key (patch, champion_id, role, opponent_id)
);

alter table public.riot_matches      enable row level security;
alter table public.riot_patch_totals enable row level security;
alter table public.riot_champ_stats  enable row level security;
alter table public.riot_ban_stats    enable row level security;
alter table public.riot_duo_stats    enable row level security;
alter table public.riot_lane_stats   enable row level security;
revoke all on public.riot_matches, public.riot_patch_totals, public.riot_champ_stats,
  public.riot_ban_stats, public.riot_duo_stats, public.riot_lane_stats from anon, authenticated;

-- Adds matches and bumps the counters. Already processed matches are skipped.
-- p_matches: [{ id, platform, patch, start (ms),
--               b: [banned champions],
--               p: [{ c: champion, r: role ('' = unknown), t: team, w: won }] }]
-- Returns the number of newly added matches
create or replace function public.riot_ingest(p_matches jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  new_ids text[];
begin
  with ins as (
    insert into riot_matches (match_id, platform, patch, game_start)
    select m->>'id', m->>'platform', m->>'patch', to_timestamp((m->>'start')::bigint / 1000.0)
    from jsonb_array_elements(p_matches) m
    on conflict (match_id) do nothing
    returning match_id
  )
  select coalesce(array_agg(match_id), '{}') into new_ids from ins;

  if cardinality(new_ids) = 0 then
    return 0;
  end if;

  drop table if exists _m, _p;
  create temp table _m on commit drop as
    select m->>'id' as id, m->>'patch' as patch, m
    from jsonb_array_elements(p_matches) m
    where m->>'id' = any(new_ids);
  create temp table _p on commit drop as
    select _m.id, _m.patch, (e->>'c')::int as c, coalesce(e->>'r', '') as r,
           (e->>'t')::int as t, (e->>'w')::boolean as w
    from _m, jsonb_array_elements(_m.m->'p') e;

  insert into riot_patch_totals as x (patch, matches)
    select patch, count(*) from _m group by patch
  on conflict (patch) do update set matches = x.matches + excluded.matches;

  insert into riot_champ_stats as x (patch, champion_id, role, games, wins)
    select patch, c, r, count(*), count(*) filter (where w)
    from _p where r <> '' group by patch, c, r
  on conflict (patch, champion_id, role) do update
    set games = x.games + excluded.games, wins = x.wins + excluded.wins;

  insert into riot_ban_stats as x (patch, champion_id, bans)
    select patch, b, count(*)
    from (select distinct _m.id, _m.patch, (b.value)::int as b
          from _m, jsonb_array_elements_text(_m.m->'b') b) s
    where b > 0 group by patch, b
  on conflict (patch, champion_id) do update set bans = x.bans + excluded.bans;

  insert into riot_duo_stats as x (patch, champion_id, role, ally_id, games, wins)
    select a.patch, a.c, a.r, b.c, count(*), count(*) filter (where a.w)
    from _p a join _p b on a.id = b.id and a.t = b.t and a.c <> b.c
    where a.r <> '' group by a.patch, a.c, a.r, b.c
  on conflict (patch, champion_id, role, ally_id) do update
    set games = x.games + excluded.games, wins = x.wins + excluded.wins;

  insert into riot_lane_stats as x (patch, champion_id, role, opponent_id, games, wins)
    select a.patch, a.c, a.r, b.c, count(*), count(*) filter (where a.w)
    from _p a join _p b on a.id = b.id and a.t <> b.t and a.r = b.r
    where a.r <> '' group by a.patch, a.c, a.r, b.c
  on conflict (patch, champion_id, role, opponent_id) do update
    set games = x.games + excluded.games, wins = x.wins + excluded.wins;

  return cardinality(new_ids);
end $$;

revoke all on function public.riot_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.riot_ingest(jsonb) to service_role;
