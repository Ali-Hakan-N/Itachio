# Development and setup

For whoever runs the backend. Players only need the [README](../README.md).

## How it works

- **Desktop app (Electron).** Connects to the local League client (LCU), follows champ select live and shows the top 10 picks for your role. Clicking a pick hovers it in the client.
- **Supabase.** Shared database for teams, pools, draft history, match results and champion stats.
- **Collector.** Runs once a day on one computer. Pulls Diamond+ matches from the Riot API (Flex first, then Solo/Duo) and turns them into meta, synergy and matchup scores.

```
score = meta score + synergy with locked allies (±15) + matchups against locked enemies (±20)
```

Matchups cover every enemy, weighted by role pair (same lane 1, bot lane 0.7, jungle 0.6, other 0.4). Synergy is negative for pairs that do worse together than expected.

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

GitHub Actions builds `FlexDrafter-Setup.exe` and attaches it to the release. The README links to `releases/latest/download/FlexDrafter-Setup.exe`, so the link stays the same for every version. The exe is unsigned, so Windows may warn on first launch (**More info > Run anyway**).

