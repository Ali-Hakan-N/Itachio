-- How each player does on each champion, learned by the collector from their own Flex
-- and Solo/Duo matches (collector/src/players). delta is in log-odds of winning,
-- relative to the player's own average: what playing this champion adds or costs them.
-- champion_id 0 with role '' holds the player's value for champions they have not played.
create table public.player_champion_stats (
  player_id   uuid not null references public.players (id) on delete cascade,
  champion_id int  not null,
  role        text not null default '',
  games       int  not null default 0,
  wins        int  not null default 0,
  early       numeric not null default 0, -- laning phase part
  late        numeric not null default 0, -- the rest of the game
  delta       numeric not null default 0, -- early + late + familiarity, as the app adds it
  updated_at  timestamptz not null default now(),
  primary key (player_id, champion_id, role)
);

alter table public.player_champion_stats enable row level security;
create policy "see self and team" on public.player_champion_stats for select to authenticated
  using (exists (select 1 from public.players p where p.id = player_id
                 and (p.user_id = auth.uid() or (p.team_id is not null and p.team_id = public.my_team_id()))));
-- Only the collector (service_role) writes
