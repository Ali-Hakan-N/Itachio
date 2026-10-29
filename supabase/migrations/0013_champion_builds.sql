-- Recommended runes, items and summoner spells per champion and role (collector/src/model/builds.js),
-- in general (bucket 'any') and against enemy teams of mostly magic ('ap'), mostly physical
-- ('ad') or mixed damage, when there are enough games for that.
create table public.champion_builds (
  champion_id int  not null,
  role        text not null,
  bucket      text not null check (bucket in ('any', 'ap', 'ad', 'mixed')),
  patch       text not null,
  games       int  not null,
  runes       jsonb not null, -- { primary, sub, perks: [keystone, 3 primary, 2 secondary, 3 shards] }
  items       jsonb not null, -- { core: [ids], more: [ids], boots: id|null }
  spells      int[] not null,
  updated_at  timestamptz not null default now(),
  primary key (champion_id, role, bucket)
);
alter table public.champion_builds enable row level security;
create policy "read" on public.champion_builds for select to authenticated using (true);
-- Only the collector (service_role) writes
