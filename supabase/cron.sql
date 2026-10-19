-- =====================================================================
-- Zamanlanmış işler (cron)
-- Önce sync-ddragon fonksiyonunu kurun (README'de anlatılıyor), sonra
-- aşağıdaki iki değeri kendi değerlerinizle değiştirip SQL Editor'da çalıştırın:
--   <PROJECT_REF>  : Supabase proje kimliğiniz (URL'deki xxxx.supabase.co kısmı)
--   <CRON_SECRET>  : fonksiyona Secret olarak verdiğiniz parola
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Her gün 06:00 UTC'de (İstanbul 09:00) şampiyon listesini güncelle
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

-- Kontrol:   select * from cron.job;
-- Son çalışmalar: select * from cron.job_run_details order by start_time desc limit 5;
-- Kaldırmak: select cron.unschedule('sync-ddragon-daily');
--
-- Veri toplayıcı (scraping / Riot API) geldiğinde buraya ikinci bir iş eklenecek.
