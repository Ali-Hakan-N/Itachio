-- Team owner with the right to remove players, and the score of every pick.

-- Score the pick had when it was locked (0-100, the app's scale)
alter table public.draft_actions add column score numeric;

-- The player who created the team; existing teams get their oldest member
alter table public.teams add column owner_id uuid references public.players(id) on delete set null;
update public.teams t
   set owner_id = (select p.id from public.players p where p.team_id = t.id order by p.created_at limit 1)
 where owner_id is null;

create or replace function public.create_team(p_name text)
returns public.teams language plpgsql security definer set search_path = public as $$
declare t public.teams;
begin
  if public.my_player_id() is null then
    raise exception 'Create your player profile first';
  end if;
  insert into public.teams(name, owner_id) values (trim(p_name), public.my_player_id()) returning * into t;
  update public.players set team_id = t.id where user_id = auth.uid();
  return t;
end $$;

-- Leaving: if the owner leaves, the next oldest member becomes the owner
create or replace function public.leave_team()
returns void language plpgsql security definer set search_path = public as $$
declare
  me uuid := public.my_player_id();
  team uuid := public.my_team_id();
begin
  update public.players set team_id = null where id = me;
  update public.teams
     set owner_id = (select p.id from public.players p where p.team_id = team order by p.created_at limit 1)
   where id = team and owner_id = me;
end $$;

-- Only the owner can remove a player from the team
create or replace function public.kick_member(p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.teams where id = public.my_team_id() and owner_id = public.my_player_id()) then
    raise exception 'Only the team owner can remove players';
  end if;
  if p_player = public.my_player_id() then
    raise exception 'Use Leave team to leave the team yourself';
  end if;
  update public.players set team_id = null where id = p_player and team_id = public.my_team_id();
  if not found then
    raise exception 'That player is not on your team';
  end if;
end $$;

revoke all on function public.kick_member(uuid), public.leave_team(), public.create_team(text) from public, anon;
grant execute on function public.kick_member(uuid), public.leave_team(), public.create_team(text) to authenticated;
