-- Dated MetaSrc inputs and out-of-time source predictions used to calibrate the ensemble.
create table public.meta_source_snapshots (
  id           bigint generated always as identity primary key,
  source       text        not null check (source = 'metasrc'),
  patch        text        not null,
  collected_at timestamptz not null,
  data         jsonb       not null
);
create index meta_source_snapshots_patch_time_idx
  on public.meta_source_snapshots (patch, collected_at desc);

create table public.ensemble_observations (
  match_id           text        primary key,
  patch              text        not null,
  started_at         timestamptz not null,
  model_snapshot_id  bigint      not null,
  source_snapshot_id bigint      not null,
  model_logit        double precision not null,
  meta_features      double precision[] not null,
  win                boolean     not null,
  created_at         timestamptz not null default now()
);
create index ensemble_observations_time_idx
  on public.ensemble_observations (started_at desc);

alter table public.meta_source_snapshots enable row level security;
alter table public.ensemble_observations enable row level security;
revoke all on public.meta_source_snapshots from anon, authenticated;
revoke all on public.ensemble_observations from anon, authenticated;
grant all on public.meta_source_snapshots to service_role;
grant all on public.ensemble_observations to service_role;
grant usage, select on sequence public.meta_source_snapshots_id_seq to service_role;