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
      + early game: κ_c × early strength + κ_s × Σ early synergy + κ_v × Σ early matchup (see below)
      + class pairs (Mage + Tank, Fighter vs Mage ...) so unseen pairs still count a little
```

- The model is built in layers: strength, then early game, synergy, matchups and latent pairs (a factorization machine that also estimates rarely seen pairs). Every layer is part of the model with what the data has so far: its regularization is tuned on held-out matches, so weights backed by little data stay small and grow as matches come in. Each layer's 5-fold cross-validated gain over the model without it is still measured and logged (paired over matches); more than 2 standard errors is reported as proven.
- The early game layer (`collector/src/model/early.js`) uses more than the result. A single win or loss says little about one matchup; the first minutes say much more, because they depend directly on the champions involved. From every match with early data it takes the early state seen from blue: per role, blue's player minus red's player (CS by 10 minutes, gold+xp lead early in and at the end of the laning phase), plus the first blood, tower, dragon, herald and grubs. Only numbers fixed early in the game: Riot's turret plates and early takedowns count over the whole game (plates alone "predicted" 92% of results), so they are left out; the clean early state predicts about 72%. Then:
  1. A logistic regression of the result on that state (the surrogate) prices every part of the early game in log-odds of winning, which puts the five lanes and the objectives on one scale.
  2. For each lane and for the objectives, a ridge regression of that priced advantage on the draft (strength, off-role, same-team pairs and enemy pairs in any roles; penalty chosen on held-out matches). A lane's advantage is mostly decided in that lane, so each regression sees little noise from the rest of the map.
  3. The predicted early advantage becomes three features of the win model: champion strength (with off-role), synergy and matchups, cross-fitted so a match's features come from models that never saw it. The win model learns how much of each turns into wins (κ_c, κ_s, κ_v) and its cross-validated gain is measured like every layer's.
  The target stays the result; the early game is only a sharper measurement of what the draft does. The win model's own strength weights stay free, so late-game value (a champion that loses lane but wins games) is still learned from results; early strength mostly helps champions with few games, whose win-only strength would be shrunk to average. In the export, early strength × κ_c is added to each champion's strength, and each pair's early weight × κ adds to its synergy or matchup (`synE`/`vsE`). Solo kills, plates and other whole-game numbers are recorded but left out of the early state, because they already contain the result.
- Regularization is in pseudo-games (tau), tuned per layer on two validation splits; pair layers also try adaptive shrinkage (iterative reweighting, close to a sparse prior), which keeps real effects and pushes noise to zero.
- The chosen model is calibrated with Platt scaling on the cross-validated predictions; each explicit weight gets a standard error, and the app marks low-data picks.
- Every training writes a report to the log and to `collector/data/model-report.json`: cross-validated accuracy with a 95% interval, log loss against an always-50% baseline, each layer's gain and whether it was kept, calibration before and after, and the top champions per role.
- Scores use a fixed 0-100 scale: `50 + 50 × tanh(pointsPerLogit × (logit - center) / 50)`. 50 is an average champion; one standard deviation of champion strength is 15 points. The scale is the same for every draft.
- Composition (`collector/src/model/comp.js`): every champion gets 4 style numbers learned from the matches, nobody labels them. A team's style is their sum T and the team gains Σ_k a_k tanh(T_k + c_k) + Tᵀ M T_enemy (M antisymmetric): tanh lets a style matter a lot from none to one champion and little after, M lets one style beat another. It is fitted on top of the calibrated cross-validated predictions of the rest of the model, starting at zero, with its penalty and number of iterations chosen on held-out matches (zero iterations, no composition, is one of the choices), and its cross-validated gain is logged like every layer's. The champions highest and lowest on each style go to `model-report.json`.
- The rest of the draft: while picks are open, every open slot on both teams gets a distribution over champions from the choice model (popularity × exp(λ × matchups against the other team)). A candidate gains its expected synergy with our future picks, and the composition is taken with the expected final styles of both teams.
- Relative to a typical pick: every board term (synergy with allies, matchups against enemies, the enemy's answers) is measured against its popularity-weighted average over the champions usually played in that role on the same board, so 50 stays "a typical pick here" whatever the board.
- Looking ahead: while the enemy still has roles open, a candidate is scored by what it is worth after they answer it: logit now − Σ open roles Σ_Y P(Y) × matchup(Y against the candidate), with P(Y) ∝ popularity(Y) × exp(λ × Y's matchups against our team). λ, how much players pick against the champions they face, is the maximum likelihood estimate over real picks (`collector/src/model/choice.js`); since pick order is not in the match data and only the later side can answer, every pick is a 50/50 mixture of answering and not answering. Even at λ = 0, champions weak against what is usually picked lose points ("Counter risk") and champions strong against it gain ("Safe blind").
- Bans: banning a champion is worth Σ over the roles the enemy still has open of P(enemy picks it there) × (its logit there − the role's average pick). P is its share of a team's games in the role divided by (1 − its ban rate), so often banned champions are not undervalued; the logit is the same model seen from the enemy (their locked picks are its allies, our picks and pick intents its enemies). Ban score = 100 × (1 − exp(−value / (0.1 × strength standard deviation))): a champion one standard deviation above its role's average that a team picks one game in ten scores 63.
- Personal layer (`collector/src/players`, **paused**: `ENABLED` in `collector/src/players/index.js` and `PLAYER_STATS` in `desktop/src/main/data.js` turn it back on): for every player with a linked account (looked up by Riot ID: the account id the League client gives is not the Riot API one) the collector fetches their Flex and Solo/Duo matches (up to 300 newest of the last year, kept in `collector/data/players`) after a training, at most every 3 hours, or with `npm run players`. Each game is split into an early part (their lane result priced by the early game surrogate, minus what an average player gets in that matchup; teammates do not enter it) and a late part (the result minus what the model expected from the draft plus that early part). Both are taken relative to the player's own average and shrunk: early by a prior estimated from the within/between champion variance, late hard (about 100 games). Champions played only a few times get a familiarity term learned from the team's first games on champions; champions never played get it fully. The result (`player_champion_stats.delta`, log-odds) adds to that player's scores in the app ("You +N").
- Until a model exists (2,000 single matches), the app falls back to the older aggregate scores (`champion_meta`, `champion_synergy`, `champion_matchup`).

The collector takes the whole current patch (each player's matches, newest first, until the previous patch), Flex first, then Solo/Duo. Single matches live in `collector/data/matches/<patch>.jsonl` (not committed), with bans, each player's early game (CS and jungle monsters by 10 minutes, turret plates, gold+xp leads, early takedowns, solo kills) and the first objectives. The training takes all of the current patch (up to 150,000 matches). While a new patch has fewer matches than a proven model needs, the newest matches of the older patches fill it up to that number, and they drop out as the new patch grows. That number is measured by the trainings: the smallest training set in which strength, early game, synergy and matchups were all proven (`collector/data/model-state.json`, 60,000 until one is seen). Only the model goes to Supabase (`model_snapshots`, newest 3 kept).

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

