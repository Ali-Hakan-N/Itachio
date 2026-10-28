-- =====================================================================
-- Scheduled jobs (cron)
-- Deploy the sync-ddragon function first (see README), then replace the two
-- values below and run this in the SQL Editor:
--   <PROJECT_REF>  : your Supabase project ref (the xxxx in xxxx.supabase.co)
--   <CRON_SECRET>  : the secret you gave the function
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Refresh the champion list every day at 06:00 UTC
select cron.schedule(
  'sync-ddragon-daily',
  '0 6 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-ddragon',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', '<CRON_SECRET>'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- Check:       select * from cron.job;
-- Recent runs: select * from cron.job_run_details order by start_time desc limit 5;
-- Remove:      select cron.unschedule('sync-ddragon-daily');
--
-- Meta / synergy / matchup data is not collected here but by the local collector (collector/).
