-- Same team functions as 0001, with English error messages (they are shown in the app).

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
