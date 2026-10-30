-- Roles a player plays (any number: the team is not a fixed five), champion statistics of
-- the season and with team-mates per line-up, and every ranked game of a player for the
-- History tab.

-- Roles, chosen by the player; history_cleared_at hides older games in their History tab
alter table public.players add column roles text[] not null default '{}'
  check (roles <@ array['top', 'jungle', 'middle', 'bottom', 'utility']);
alter table public.players add column history_cleared_at timestamptz;
grant update (roles, history_cleared_at) on public.players to authenticated;

-- Champion statistics, three kinds (collector/src/players):
--   season   the player's Solo/Duo and Flex games of the season
--   history  the same games of the current patch
--   team     their games with other team members on their side, per line-up: lineup is
--            the sorted ids of the team members on that side, the player included
-- The earlier team rows needed games recorded in full by the app; they are replaced.
delete from public.player_champion_stats where source = 'team';
alter table public.player_champion_stats drop constraint player_champion_stats_source_check;
alter table public.player_champion_stats add constraint player_champion_stats_source_check
  check (source in ('season', 'history', 'team'));
alter table public.player_champion_stats add column lineup text not null default '';
alter table public.player_champion_stats drop constraint player_champion_stats_pkey;
alter table public.player_champion_stats add primary key (player_id, champion_id, role, source, lineup);

-- A player's ranked games of the season, from Riot, written by the collector
create table public.player_games (
  player_id   uuid not null references public.players (id) on delete cascade,
  match_id    text not null,
  started_at  timestamptz not null,
  queue_id    int  not null,
  patch       text not null,
  duration_s  int,
  side        text not null check (side in ('blue', 'red')),
  role        text not null,
  champion_id int  not null,
  win         boolean not null,
  kills       int,
  deaths      int,
  assists     int,
  cs          int,
  blue        int[] not null, -- champions by role: top, jungle, mid, bot, support
  red         int[] not null,
  lineup      text not null default '', -- team members on the player's side, when more than them
  primary key (player_id, match_id)
);
create index player_games_time_idx on public.player_games (player_id, started_at desc);

alter table public.player_games enable row level security;
create policy "see self and team" on public.player_games for select to authenticated
  using (exists (select 1 from public.players p where p.id = player_id
                 and (p.user_id = auth.uid() or (p.team_id is not null and p.team_id = public.my_team_id()))));
-- Only the collector (service_role) writes
