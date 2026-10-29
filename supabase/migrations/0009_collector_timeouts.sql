-- The collector (service_role) writes counters from four regions at once; under that
-- load a batch can need more than the default 8 seconds. Only service_role gets the
-- longer limits; the app's roles keep theirs.
alter role service_role set statement_timeout = '120s';
alter role service_role set lock_timeout = '60s';
notify pgrst, 'reload config';
