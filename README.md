# Flex Drafter

A League of Legends draft assistant for a team that plays Flex together. It reads champ select live from the League client, suggests the best picks for your role, and saves drafts and results to a shared database.

## How it works

- **Desktop app (Electron).** Each player runs it on their own computer. It connects to the local League client (LCU), follows bans and picks live, and shows the top 10 champions you can pick.
- **Supabase.** Shared database for teams, champion pools, draft history, match results and champion stats.
- **Collector.** Runs once a day on one computer. It pulls Diamond+ matches from the Riot API (Flex first, then Solo/Duo) and turns them into meta, synergy and matchup scores.

A recommendation's score is:

```
score = meta score + synergy with locked allies (up to +15) + matchup against locked enemies (±20)
```

## Folders

```
desktop/     Electron app (LCU connection, draft screen, recommendation engine)
collector/   Daily data job (Riot API -> scores -> Supabase)
supabase/    Database migrations, champion sync function, cron
```

## Setup

Done once, by one person on the team.

### 1. Supabase

1. Create a project on [supabase.com](https://supabase.com).
2. Apply the migrations: `npx supabase link --project-ref <ref>` then `npx supabase db push`.
3. Optional: turn off **Authentication > Email > Confirm email** so players can sign in right after signing up.

### 2. Champion sync

```bash
npx supabase secrets set CRON_SECRET=<long random value>
npx supabase functions deploy sync-ddragon
```

Fill in `<PROJECT_REF>` and `<CRON_SECRET>` in `supabase/cron.sql` and run it in the SQL Editor. Don't commit the filled-in file.

### 3. App config

Copy `desktop/config.example.json` to `desktop/config.json` and fill in the project URL and the **publishable** (anon) key. Never use the service_role key here.

### 4. Collector

```bash
cd collector
npm install
cp .env.example .env      # fill in SUPABASE_SERVICE_ROLE_KEY and RIOT_API_KEY
npm run collect:dry       # quick check, writes nothing
npm run collect           # real run (about 40 minutes)
powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1   # daily at 10:00
```

- Get a Riot key at [developer.riotgames.com](https://developer.riotgames.com). Development keys expire every 24 hours; a Personal API key does not.
- If the key has expired, the run stops and logs it without touching the data.
- Scores are only replaced when there is enough data, so the first days of a new patch keep the previous scores.

## Development

Requires Node.js 22+.

```bash
cd desktop
npm install
npm start
```

Try it without League:

```bash
npm run dev:mock                       # terminal 1: mock client, prints LCU_LOCKFILE
$env:LCU_LOCKFILE="<path>"; npm start  # terminal 2 (PowerShell)
```

Tests: `npm test` in `desktop/` and in `collector/`.

## Release

Add `SUPABASE_URL` and `SUPABASE_KEY` as repository secrets, then push a tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions builds the Windows installer and attaches it to the release. The exe is unsigned, so Windows may warn on first launch (**More info > Run anyway**).

## Using the app

1. Sign up and save your profile (nickname, main role).
2. One player creates the team and shares the invite code from the **Team** tab; the others join with it.
3. Optionally add your champions in **My pool**. They are marked in the list but don't change the score.
4. Open League. The app finds the client on its own, and the **Draft** tab updates live in champ select.

## Roadmap

- [x] Live draft from the LCU, teams and pools, draft and result history
- [x] Recommendations from meta, synergy and matchups
- [x] Daily Riot API collector
- [ ] Player stats from the Riot API
- [ ] Our own prediction model trained on match data

## Legal

Flex Drafter isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
