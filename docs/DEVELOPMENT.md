# Development and setup

For whoever runs the backend. Players only need the [README](../README.md).

## How it works

- **Desktop app (Electron).** Connects to the local League client (LCU), follows champ select live and shows the top 10 picks for your role. Clicking a pick hovers it in the client.
- **Supabase.** Shared database for teams, pools, draft history, match results and champion stats.
- **Collector.** Runs once a day on one computer, up to ~23 hours (until the development key expires). Pulls Diamond+ matches from the Riot API (Flex first, then Solo/Duo), keeps each match on that computer, trains a win model on them every hour and uploads the model.

## Scoring

The win model is a logistic regression for "does blue win", learned from single matches:

```
logit = strength(champion, role) + off-role(role) × -ln(share of the champion's games in that role)
      + Σ synergy(champion, role, ally, ally role)
      + Σ matchup(champion, role, enemy, enemy role)
      + early game: κ_s × Σ early synergy + κ_v × Σ early matchup (see below)
      + class pairs (Mage + Tank, Fighter vs Mage ...) so unseen pairs still count a little
```

- The model is built in layers: strength, then early game, synergy, matchups and latent pairs (a factorization machine that also estimates rarely seen pairs). A layer is kept only if 5-fold cross-validated predictions improve on the model without it by more than 2 standard errors, paired over matches. Rejected layers are left out of the model.
- The early game layer (`collector/src/model/early.js`) uses more than the result. A single win or loss says little about one matchup; the first minutes say much more, because they depend directly on the champions involved. From every match with early data it takes the early state seen from blue: per role, blue's player minus red's player (CS by 10 minutes, turret plates, gold+xp lead early in and at the end of the laning phase, takedowns in the first minutes), plus the first blood, tower, dragon, herald and grubs. Then:
  1. A logistic regression of the result on that state (the surrogate) prices every part of the early game in log-odds of winning, which puts the five lanes and the objectives on one scale.
  2. For each lane and for the objectives, a ridge regression of that priced advantage on the draft (strength, off-role, same-team pairs and enemy pairs in any roles; penalty chosen on held-out matches). A lane's advantage is mostly decided in that lane, so each regression sees little noise from the rest of the map.
  3. The pair part of the predicted early advantage becomes two features of the win model, synergy and matchups, cross-fitted so a match's features come from models that never saw it. The win model learns how much of it turns into wins (κ_s, κ_v) and keeps the layer only by the same rule as every layer: cross-validated win predictions must improve by more than 2 standard errors.
  The target stays the result; the early game is only a sharper measurement of what the draft does. In the app each pair's early weight × κ adds to its synergy or matchup (`synE`/`vsE`). Solo kills and other whole-game numbers are recorded but left out of the early state, because they already contain the result.
- Temporary pairs bridge the time until synergy or matchups are proven. While a pair layer is rejected, the training still tests every pair with at least 30 games (any roles, not only lane opponents) one by one against the model's cross-validated predictions, and exports the pairs that pass Benjamini-Hochberg selection at a 10% false discovery rate (`synT`/`vsT`), so at most about one in ten exported pairs is chance however many are tested. The app phases them in by evidence (no effect at 1.5 standard errors, full from 2.5) and caps them (about 9 points per pair, 20 in total). Once the training proves a layer, its temporary pairs are no longer produced and the learned layer takes over.
- Regularization is in pseudo-games (tau), tuned per layer on two validation splits; pair layers also try adaptive shrinkage (iterative reweighting, close to a sparse prior), which keeps real effects and pushes noise to zero.
- The chosen model is calibrated with Platt scaling on the cross-validated predictions; each explicit weight gets a standard error, and the app marks low-data picks.
- Every training writes a report to the log and to `collector/data/model-report.json`: cross-validated accuracy with a 95% interval, log loss against an always-50% baseline, each layer's gain and whether it was kept, calibration before and after, and the top champions per role.
- Scores use a fixed 0-100 scale: `50 + 50 × tanh(pointsPerLogit × (logit - center) / 50)`. 50 is an average champion; one standard deviation of champion strength is 15 points. The scale is the same for every draft.
- Bans: banning a champion is worth Σ over the roles the enemy still has open of P(enemy picks it there) × (its logit there − the role's average pick). P is its share of a team's games in the role divided by (1 − its ban rate), so often banned champions are not undervalued; the logit is the same model seen from the enemy (their locked picks are its allies, our picks and pick intents its enemies). Ban score = 100 × (1 − exp(−value / (0.1 × strength standard deviation))): a champion one standard deviation above its role's average that a team picks one game in ten scores 63.
- Until a model exists (2,000 single matches), the app falls back to the older aggregate scores (`champion_meta`, `champion_synergy`, `champion_matchup`).

Single matches live in `collector/data/matches/<patch>.jsonl` (not committed), with bans, each player's early game (CS and jungle monsters by 10 minutes, turret plates, gold+xp leads, early takedowns, solo kills) and the first objectives. The training takes the newest 150,000 matches, current patch first; after a new patch the older ones fill the rest until the new patch replaces them. Only the model goes to Supabase (`model_snapshots`, newest 3 kept).

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

