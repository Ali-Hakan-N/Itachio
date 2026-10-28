-- Cross-lane matchups and negative synergy.
--
-- riot_vs_stats counts every pair of opposing champions in different roles
-- (e.g. bot vs enemy support, jungle vs enemy mid). Same-lane pairs stay in
-- riot_lane_stats. Only matches ingested from now on are counted here.
--
-- champion_matchup gets the opponent's role; champion_synergy may go negative
-- (pairs that do worse together than expected).

create table public.riot_vs_stats (
  patch         text    not null,
  champion_id   integer not null,
  role          text    not null,
  opponent_id   integer not null,
  opponent_role text    not null,
  games         integer not null default 0,
  wins          integer not null default 0,
  primary key (patch, champion_id, role, opponent_id, opponent_role)
);
alter table public.riot_vs_stats enable row level security;
revoke all on public.riot_vs_stats from anon, authenticated;

alter table public.champion_synergy drop constraint champion_synergy_strength_check;
alter table public.champion_synergy add constraint champion_synergy_strength_check check (strength between -1 and 1);

alter table public.champion_matchup add column opponent_role text;
update public.champion_matchup set opponent_role = role;
alter table public.champion_matchup alter column opponent_role set not null;
alter table public.champion_matchup add constraint champion_matchup_opponent_role_check
  check (opponent_role in ('top','jungle','middle','bottom','utility'));
alter table public.champion_matchup drop constraint champion_matchup_pkey;
alter table public.champion_matchup add primary key (champion_id, role, opponent_id, opponent_role, source);

create or replace function public.riot_ingest(p_matches jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  new_ids text[];
begin
  with ins as (
    insert into riot_matches (match_id, platform, patch, queue, game_start)
    select m->>'id', m->>'platform', m->>'patch', (m->>'queue')::int,
           to_timestamp((m->>'start')::bigint / 1000.0)
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

  insert into riot_vs_stats as x (patch, champion_id, role, opponent_id, opponent_role, games, wins)
    select a.patch, a.c, a.r, b.c, b.r, count(*), count(*) filter (where a.w)
    from _p a join _p b on a.id = b.id and a.t <> b.t and a.r <> b.r
    where a.r <> '' and b.r <> '' group by a.patch, a.c, a.r, b.c, b.r
  on conflict (patch, champion_id, role, opponent_id, opponent_role) do update
    set games = x.games + excluded.games, wins = x.wins + excluded.wins;

  return cardinality(new_ids);
end $$;

revoke all on function public.riot_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.riot_ingest(jsonb) to service_role;
