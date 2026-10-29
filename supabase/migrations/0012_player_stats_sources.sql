-- Two kinds of champion statistics per player:
--   history  their Solo/Duo and Flex games of the current patch, read from Riot
--   team     the Flex games the whole team played together, recorded by the app
-- The rows written so far came from the older Riot analysis, so they are marked history;
-- the collector replaces each player's rows of a kind when it writes that kind again.
alter table public.player_champion_stats add column source text not null default 'history'
  check (source in ('history', 'team'));
alter table public.player_champion_stats alter column source drop default;
alter table public.player_champion_stats drop constraint player_champion_stats_pkey;
alter table public.player_champion_stats add primary key (player_id, champion_id, role, source);

-- Resetting starts over the team statistics only: history follows Riot's data for the patch
create or replace function public.reset_my_champion_stats()
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.my_player_id();
begin
  if me is null then raise exception 'No player profile'; end if;
  update public.players set stats_reset_at = now() where id = me;
  delete from public.player_champion_stats where player_id = me and source = 'team';
end $$;
