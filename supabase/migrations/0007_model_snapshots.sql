-- Learned draft model.
--
-- The collector trains a win model on single matches (kept on the collector's
-- computer) and uploads its weights here as one JSON document per training.
-- The app reads the newest row in a single request. Old rows are pruned by the
-- collector.

create table public.model_snapshots (
  id         bigint generated always as identity primary key,
  source     text        not null,
  patch      text        not null,
  matches    integer     not null,
  metrics    jsonb,
  data       jsonb       not null,
  created_at timestamptz not null default now()
);

alter table public.model_snapshots enable row level security;
revoke all on public.model_snapshots from anon;
grant select on public.model_snapshots to authenticated;
revoke insert, update, delete on public.model_snapshots from authenticated;
create policy "read" on public.model_snapshots for select to authenticated using (true);
