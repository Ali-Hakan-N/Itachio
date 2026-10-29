-- Champion statistics from the team's own games: the collector reads the Flex games the
-- whole team played together (all five recorded by the app) from Riot by match id, so a
-- draft needs its server. A player can reset their champion data: games before
-- stats_reset_at no longer count for them.
alter table public.drafts add column platform text; -- "TR1", "EUW1" ... as the client reports it
alter table public.players add column stats_reset_at timestamptz;

-- Starts the caller's champion data over: their stats rows go and earlier games stop counting
create or replace function public.reset_my_champion_stats()
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.my_player_id();
begin
  if me is null then raise exception 'No player profile'; end if;
  update public.players set stats_reset_at = now() where id = me;
  delete from public.player_champion_stats where player_id = me;
end $$;
revoke all on function public.reset_my_champion_stats() from public, anon;
grant execute on function public.reset_my_champion_stats() to authenticated;
