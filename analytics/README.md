# Itachio Analytics

This TypeScript workspace adds an Itachio-owned experimental draft model (gradient boosted trees over 58 dense features and a sparse champion layer), ClickHouse ingestion, pairwise item ranking, cross-fitted causal estimation, and an MCP matchup tool. It does not reproduce Winrate.gg's private schema, training data, or model weights.

## Install and test

```powershell
npm install --prefix analytics
npm run build --prefix analytics
npm test --prefix analytics
```

`onnxruntime-node` and `onnx-proto` are runtime dependencies. The ONNX protobuf runtime is pinned through the package override to a patched `protobufjs` release.

## Train the draft model

The trainer reads Itachio compact Match-V5 JSONL, uses the oldest 70% of games to build historical features and fit a sparse champion layer, and fits histogram gradient boosted trees (`src/gbdt.ts`, LightGBM's method in TypeScript, no native dependency) on a capped later window. Its newest 20% drives early stopping, the blend toward a win-rate prior where picks have few games, and calibration. The ONNX artifact is a standard `TreeEnsembleRegressor` with a sigmoid. Columns with no real historical value (`pick_order`, `enemy_answer_share`, `rank_tier`, `patch_age`, `candidate_range`) are masked: Match-V5 does not record draft order, and rank at match time is unknown unless a rank map is supplied. Set `META_PRIOR_PATH` to a JSON file of `{ "<champion>:<lane>": winRate }` to use MetaSRC rates as the prior.

```powershell
npm run train --prefix analytics -- ../collector/data/matches/16.21.jsonl
```

The default cap is 30,000 later matches. Set `DRAFT_TRAIN_MATCHES` or `DRAFT_ONNX_PATH` to adjust the run.

## Compare with the production model

```powershell
npm run backtest --prefix analytics -- ../collector/data/matches/16.21.jsonl
```

Fits the candidate and the production trainer (`collector/src/model`) on the same older matches and scores both on the newest 30% of the matches with a start time. The result goes to `models/backtest.json`. A candidate only passes when its paired logloss gain exceeds 2 standard errors. The command reads local files and uploads nothing.

## ClickHouse ingestion

Set `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, and optionally `CLICKHOUSE_DATABASE`. Apply the schema with the ingest command; it loads compact matches and inserts both PUUID-free match summaries and the generated draft observations in batches.

```powershell
npm run ingest --prefix analytics -- ../collector/data/matches/16.21.jsonl [rank-tier-map.json]
```

The optional JSON map is keyed by Riot match ID and must contain the tier observed for that match. Without historical rank enrichment, rows are stored as `UNKNOWN`; rank-standardized matchup queries exclude them rather than pretending current rank was historical rank. This is a local collector ingest path, not a community upload service: Electron clients do not send matches to ClickHouse, and no consent, identity-minimization, or server-side ingestion endpoint is configured. A shared corpus could reduce repeated Riot API lookups, but would not make the project independent of Riot data or API policy.

## MCP endpoint

The HTTP endpoint is Streamable HTTP at `/mcp`, uses the current MCP TypeScript v2 packages, and defaults to `127.0.0.1:8787`. It requires ClickHouse credentials. Set `MCP_HOST` to a non-loopback address only with a strong `MCP_BEARER_TOKEN` and `MCP_PUBLIC_HOST`.

```powershell
npm run serve:mcp --prefix analytics
```

The `analyze_matchup` tool is read-only and parameterizes champion, lane, patch, and queue. It standardizes lane win rate using the observed rank-tier distribution for that patch and queue.

## Item and causal models

The item ranker learns pairwise weights from historical preferred/rejected item observations; it does not ship fabricated LambdaMART weights. The causal estimator is a cross-fitted R-learner over pre-treatment confounders. Minute-10 gold is descriptive and is intentionally not controlled as a confounder for a minute-5 treatment because it may be a mediator. An optional OpenAI-compatible endpoint only narrates the computed effect; it cannot change the estimate or confidence interval. Without an API key, deterministic copy is returned.

## Release status

This analytics package is not yet wired into the Electron draft screen or deployed against a ClickHouse service. The current desktop release workflow only builds Electron. Do not tag a desktop release as a complete Winrate.gg-equivalent until the model's full-corpus validation, historical rank/timeline enrichment, and desktop inference integration are verified.