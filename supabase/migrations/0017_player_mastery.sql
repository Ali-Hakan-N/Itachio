-- Comfort on a champion from champion mastery (collector/src/players/mastery.js), 0-1:
-- how far the player's own results on it are trusted earlier (it loosens the shrinkage
-- in the analysis; it is not a score by itself).
alter table public.player_champion_stats add column mastery numeric not null default 0;
