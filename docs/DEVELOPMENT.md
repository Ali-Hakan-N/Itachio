# Development and setup

For whoever runs the backend. Players only need the [README](../README.md).

## How it works

- **Desktop app (Electron).** Connects to the local League client (LCU), follows champ select live and shows the top 10 picks for your role. Clicking a pick hovers it in the client.
- **Supabase.** Shared database for teams, pools, draft history, match results and champion stats.
- **Collector.** Runs once a day on one computer, up to ~23 hours (until the development key expires). Work goes in this order: the team's players first (their ranked games and statistics, again every 2 hours; their requests go ahead of everything else while they run), then Diamond+ matches from every server (Flex first, then Solo/Duo), then, in the last 15% of the time, build data (starting items from the timelines of the stored matches). It keeps each match on that computer, trains a win model on them every hour and uploads the model.
- Collector training keeps up to 300,000 newest matches by default; set `MODEL_MAX_TRAIN_MATCHES=500000` (or at most `1000000`) in `collector/.env` to raise it. Sparse matrices are preallocated as typed arrays; CV scoring still covers the retained dataset, while final, early-game and style coefficient fitting use representative capped samples with full-cohort-equivalent regularization. Increase in stages and monitor `collect.log` and memory.

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
- The model/MetaSrc blend is selected only from out-of-time predictions: migration `0016` stores dated MetaSrc snapshots and future-match observations; the collector ignores matches unless both the model and same-patch MetaSrc snapshot predate them. After 500 observations, it calibrates MetaSrc on the oldest half, tunes weights on the next 20%, and adopts a lower model weight only when it beats the 50/50 model/MetaSrc blend by more than two standard errors on the newest 30%. The selected MetaSrc calibration is also used by the desktop in the same logit space. Until then, the confidence-based weight is capped at 50%. Apply database migrations with `npx supabase db push`.
- Every training writes a report to the log and to `collector/data/model-report.json`: cross-validated accuracy with a 95% interval, log loss against an always-50% baseline, each layer's gain and whether it was kept, calibration before and after, and the top champions per role.
- Scores use a fixed 0-100 scale: `50 + 50 × tanh(pointsPerLogit × (logit - center) / 50)`. 50 is an average champion; one standard deviation of champion strength is 15 points. The scale is the same for every draft.
- Composition (`collector/src/model/comp.js`): every champion gets 4 style numbers learned from the matches, nobody labels them. A team's style is their sum T and the team gains Σ_k a_k tanh(T_k + c_k) + Tᵀ M T_enemy (M antisymmetric): tanh lets a style matter a lot from none to one champion and little after, M lets one style beat another. It is fitted on top of the calibrated cross-validated predictions of the rest of the model, starting at zero, with its penalty and number of iterations chosen on held-out matches (zero iterations, no composition, is one of the choices), and its cross-validated gain is logged like every layer's. The champions highest and lowest on each style go to `model-report.json`.
- Composition pillars add regularized, cross-validated class proxies for damage-type imbalance, frontline and control plus two interactions: high damage with low control, and frontline with marksmen. They come from primary Data Dragon tags, not literal damage/CC measurements; the model learns whether each term helps in held-out matches.
- The rest of the draft: while picks are open, every open slot on both teams gets a distribution over champions from the choice model (popularity × exp(λ × matchups against the other team)). A candidate gains its expected synergy with our future picks, and the composition is taken with the expected final styles of both teams.
- Uncertain strength counts less: a champion's strength in a role is scored at its estimate minus one standard error beyond the role's usual (games-weighted) standard error. Rare picks (off-role, niche) rest on few games, mostly from players who specialize in them (Master Yi bot: 125 games, 57.6% won), so their estimates are noisy and flattering; this lowers them in proportion, less and less as games add up. Champions never seen in a role, or picked there by less than 1% of teams (off-meta), are not recommended; they can still be hovered and scored. Rarity is not learned from results on purpose: the results reward it, because the few who pick rare champions are specialists. The look-ahead terms also count in proportion to the evidence: games / (games + the strength layer's prior in pseudo-games).
- Relative to a typical pick: every board term (synergy with allies, matchups against enemies, the enemy's answers) is measured against its popularity-weighted average over the champions usually played in that role on the same board, so 50 stays "a typical pick here" whatever the board.
- Looking ahead: while the enemy still has roles open, a candidate is scored by what it is worth after they answer it: logit now − Σ open roles Σ_Y P(Y) × matchup(Y against the candidate), with P(Y) ∝ popularity(Y) × exp(λ × Y's matchups against our team). λ, how much players pick against the champions they face, is the maximum likelihood estimate over real picks (`collector/src/model/choice.js`); since pick order is not in the match data and only the later side can answer, every pick is a 50/50 mixture of answering and not answering. Even at λ = 0, champions weak against what is usually picked lose points ("Counter risk") and champions strong against it gain ("Safe blind").
- Bans: banning a champion is worth Σ over the roles the enemy still has open of P(enemy picks it there) × (its logit there − the role's average pick). P is its share of a team's games in the role divided by (1 − its ban rate), so often banned champions are not undervalued; the logit is the same model seen from the enemy (their locked picks are its allies, our picks and pick intents its enemies). For a teammate who has not shown a pick intent yet, the champion they play most in their role this patch (their history statistics) stands in for them, so bans go to what beats the champions our players actually play. Ban score = 100 × (1 − exp(−value / (0.1 × strength standard deviation))): a champion one standard deviation above its role's average that a team picks one game in ten scores 63.
- Personal layer (`collector/src/players`): every team member's Solo/Duo and Flex games of the season are read from Riot (looked up by Riot ID: the account id the League client gives is not the Riot API one; the season is the first number of the patch). They give three kinds of statistics, kept apart (`player_champion_stats.source`): **season**, all of them; **history**, those of the current patch; and **team**, those where all five on the player's side were team members, nobody from outside, per line-up (`lineup`: the sorted ids of the five; team-mates are matched by their Riot account). Each game is split into the lane (priced by the early game surrogate, minus what an average player gets in that matchup) and the rest (the result minus what the model expected from the draft plus that lane), relative to the player's own average and shrunk hard (lane: at least 10 games of prior, rest: about 200), so a few good games do not make a champion look mastered. In the app the season and patch statistics always count, and the team statistics when the five on our side in the draft are a line-up the player has games with (`Engine.personalFor`); they add up, count half, and are capped at 0.4 standard deviations of strength (about 7 points). All three fill the Champions tab. The games also go to `player_games` for the History tab (a player can hide older ones: `players.history_cleared_at`).
- Builds (`collector/src/model/builds.js`, table `champion_builds`): per champion and role, and per enemy damage type (physical, mixed, magic: the lower and upper thirds of a team's magic damage share, kept in `app_meta.champion_damage`). The keystone is the best shrunk win rate (200 games of prior) among those picked in at least 25% of games; the other runes, the two spells and the items are the most common choices, items being the completed ones (boots only when at least 20% of games end with them). Starting items are the most common set among matches read with their timeline (one match in 8 during the crawl, a second request; at least 15 games). `items.pool` holds every item and boots at least 3% of players end with: the champion's real choices. A damage type needs 80 games, otherwise the build for any enemy is used.
- Situational items (`analyzeSituations`, `app_meta.item_situations`): every champion has a profile measured from the matches (share of damage that is magic, healing per minute, crowd control seconds per minute, assassin or not), standardized over champions; an enemy team's profile is the sum. Each player-game's result is compared with the champion's win rate in that role with as many completed items (a stand-in for game length), and with what the enemy profile does to everyone in that role; per item, a ridge regression of what is left over its buyers' games on the enemy profile gives what each part is worth (parts within 1.5 standard errors of zero are dropped). In the draft, the champion's pool items worth at least 1% more win chance against this enemy team than against an average one are recommended (up to 3), with the parts that make them worth it ("vs healing", "vs magic damage"). Learning per item and enemy champion directly was too noisy for a patch's games; through profiles, magic resist and armor items already sort themselves by enemy damage. Healing and crowd control are measured from matches recorded since 0.2.1; until a champion has 20 of them, those parts count as average.
- The app sends runes (its own "Itachio" page) with spells, and the item set (starting items, core, boots, situational, also built) once every champion is locked, once per game, when the options say so (Options > Drafting, off by default); the Apply buttons send them by hand.
- Pick order: teammates are ordered by their likely champion's counter risk, with a small role-aware blind-pick preference (jungle/support, bot, mid, top). Strong counter-risk differences can still override the role preference; where the suggested order differs from the client's, a pick trade is shown (at most two), except between players picking simultaneously.
- Game plan: from the final draft, all in percentage points of win chance. The win chance is split into champions (strength, off-role), synergy, matchups and composition (`winParts`). Each lane is the learned lane matchup: the early game layer exports `laneVs`, the average priced lane result of every lane pairing with at least 15 games, shrunk toward the two champions' average lanes with 20 games of prior, and `objMean`, each champion's part of its side's first objectives. Without a learned pairing the two average lanes are used. Early = lanes + objectives; later = the rest of the draft's edge. A lane is ahead or behind beyond 0.6 standard deviations of its role. The advice lines are built from the same numbers with one threshold (1 point, half for objectives), so they never contradict the panel. After the game the same plan is shown with the result and every player's score and numbers.
- Champions to Learn: for each role the player chose in the Team tab (else the role they play most), the five best scored champions they do not already play there, next to the champions their teammates usually play.
- Until a model exists (2,000 single matches), the app falls back to the older aggregate scores (`champion_meta`, `champion_synergy`, `champion_matchup`).

The collector takes the whole current patch (each player's matches, newest first, until the previous patch), Flex first, then Solo/Duo. Single matches live in `collector/data/matches/<patch>.jsonl` (not committed), with bans, each player's early game (CS and jungle monsters by 10 minutes, turret plates, gold+xp leads, early takedowns, solo kills) and the first objectives. Training uses up to `MODEL_MAX_TRAIN_MATCHES` matches (300,000 by default, hard-capped at 1,000,000). While a new patch has fewer matches than a proven model needs, the newest matches of the older patches fill it up to that number, and they drop out as the new patch grows. That number is measured by the trainings: the smallest training set in which strength, early game, synergy and matchups were all proven (`collector/data/model-state.json`, 60,000 until one is seen). Only the model goes to Supabase (`model_snapshots`, newest 3 kept).

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
4. Add `itachio://auth/callback` to **Authentication > URL Configuration > Redirect URLs** for password recovery.

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

GitHub Actions builds `Itachio-Setup.exe` and attaches it to the release. The README links to `releases/latest/download/Itachio-Setup.exe`, so the link stays the same for every version. The exe is unsigned, so Windows may warn on first launch (**More info > Run anyway**).

