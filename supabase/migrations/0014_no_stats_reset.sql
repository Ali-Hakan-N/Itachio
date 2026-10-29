-- Champion statistics are never reset: every Flex game the whole team played together counts
drop function if exists public.reset_my_champion_stats();
alter table public.players drop column if exists stats_reset_at;
