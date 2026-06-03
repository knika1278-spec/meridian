# Meteora DLMM Screener Agent — AGENTS.md

Autonomous CLI agent that screens Meteora DLMM pools (hard filters → enrichment →
LLM decision), auto-opens LP positions, manages them on a cron, and runs a
shadow/active learning loop. TypeScript / ESM / Node ≥ 20.

---

## Architecture Overview

```
src/cli.ts            Commander entrypoint: builds deps, wires agents, owns cron + WS + heartbeat watchdog
src/config/
  config.ts           Zod-validated config loader; env overrides + secret getters; shadow/live sanity gate
  user-config.json    Runtime config (filters, scheduler cron, llm, manager, capital, learning, memory)

src/agents/
  screener.agent.ts   Core pipeline: fetch → enrich → hard filters → LLM batch → auto-open ENTER → persist
  manager.agent.ts    Position lifecycle on cron: evaluate → hold/claim/close/rebalance; open()
  position-evaluator.ts   Per-position in-range %, claimable fees, PnL (local + optional Meteora PnL API)
  position-tracker.ts     Canonical open positions (positions.json)
  closed-position-store.ts Canonical closed outcomes (closed-positions.json)
  lesson-store.ts         Manager lessons (lessons.json)
  capital-manager.ts      Startup SOL↔USDC rebalance to target split (capital.enabled)
  cleanup-runner.ts       Reclaims rent from phantom/empty positions at startup
  realtime.listener.ts    Helius Enhanced WS (transactionSubscribe) → RealtimeEvent buffer per pool

src/tools/            Thin wrappers over external APIs/SDKs (no business logic)
  meteora.tools.ts    Meteora REST (/pools windowed metrics) + on-chain DLMM SDK enrichment
  meteora-actions.tools.ts  Deploy / close / claim / rebalance via @meteora-ag/dlmm
  meteora-pnl.tools.ts      Optional remote PnL API
  jupiter.tools.ts          Token info / audit / launchpad / price stats / organic score
  jupiter-swap.tools.ts     Jupiter swap (capital rebalance)
  okx.tools.ts              OKX Web3: token risk score + smart-money signals
  helius.tools.ts           RPC connection factory + WS helpers
  wallet.tools.ts           SOL/token balances + signing
  dlmm-loader.ts            Defensive dynamic import of the DLMM SDK

src/llm/              Provider abstraction
  factory.ts          createLlmProvider(config.llm)
  Codex-cli.ts       Spawns local `Codex` binary
  mimo.ts             OpenAI-compatible HTTP provider (current config)
  types.ts            LlmProvider interface

src/learning/         Shadow/active learning loop (JSONL-backed)
  recorder.ts         Records screener/manager decisions
  outcome-scheduler.ts + entry-outcome.ts + realized-outcome.ts + outcome-collector.ts
  evidence-index.ts   Recency-weighted cohort index
  shadow-ranker.ts    Scores each decision vs cohort; flags LLM disagreement
  lesson-miner.ts     Derives lessons from closed-position cohorts
  snapshot-emitter.ts Writes learning-snapshot.jsonl for the dashboard
  score-net-pnl-risk.ts + decision-id.ts + jsonl-store.ts

src/memory/           Decision memory
  decision-journal.ts append-only journal (decision-journal.jsonl) with onAppend hooks
  memory-router.ts    Builds prompt-memory bundles (journal + lessons + learning evidence)

src/notifications/telegram.ts   Notifications + control center + command intake (commands.jsonl)
src/utils/            logger, decision-logger, jsonl-emitter, realtime-signal-snapshot,
                      config-watcher (hot-reload), command-consumer, formatter, review, progress

prompts/              LLM system prompts: screener / manager / realtime / post-mortem (.system.md)
web/                  Next.js read-only dashboard (tails JSONL/state over one WS)
ecosystem.config.cjs  PM2: meteora-bot (dist/cli.js start) + meteora-web (web/server.mjs)
```

---

## Commands

| npm script | Underlying | Purpose |
|---|---|---|
| `npm run screen` | `cli.ts screen` | One screening cycle, print table, exit |
| `npm run auto` | `cli.ts start` | Autonomous: cron screen + realtime WS + manager cron + watchdog |
| `npm run realtime` | `cli.ts realtime` | WS listener only, prints live events |
| `npm run dev` | `tsx src/cli.ts` | Dev runner |
| `npm run build` | `tsc` | Compile to `dist/` |
| `npm run typecheck` | `tsc --noEmit` | Type check only |
| `npm test` | `tsx --test` | Run `src/**/*.test.ts` |

CLI subcommands: `screen` `start` `manage` `wallet` `realtime` `candidates`
`config` `review-decisions` `cleanup-empty-positions`.
Global flags: `--config <path>`, `--verbose`. `start` flags: `--no-realtime`
`--no-cron` `--no-manager`. `screen` flags: `--limit N` `--dry-run` `--no-llm`.

---

## Screener Pipeline (`screener.agent.ts runOnce`)

1. **Fetch** — `meteora.fetchAllPairs({ limit, sortBy: "fees_24h" })` (sorted desc → best LLM ROI first)
2. **Enrich** — per token, parallel: Jupiter (audit/launchpad/priceStats/organicScore) + OKX (risk + smart-money) when enabled
3. **Hard filters** — `applyFilters()` builds a `FilterReportEntry` per gate; pool passes only if ALL pass
4. **LLM batch** — concurrency 3, capped at `llm.maxCallsPerScreenCycle`; JSON-mode decision validated by Zod `DecisionSchema`
5. **Auto-open** — ENTER decisions with `confidence ≥ 0.6` trigger `manager.open()` (skipped under dryRun)
6. **Persist** — decision log, decision journal, learning recorder + shadow ranker, candidates/llm-runs JSONL snapshots

LLM decision shape: `{ action: ENTER|WATCH|SKIP, confidence 0..1, reasons[], risks[], suggestedSizeUsd?, suggestedRangeBps?, notes? }`.

---

## Hard Filters (config.filters)

| Filter | Key | Default |
|---|---|---|
| Fee / active-TVL ratio (per window, percentage points) | `feeActiveTvlRatioMin` | 0.05 |
| Token organic score (speculative side) | `organicScoreMin` | 60 |
| Holders (speculative side) | `holdersMin` | 500 |
| Market cap range (speculative side) | `marketCapMin` / `marketCapMax` | 150k / 10M |
| Bin step range | `binStepMin` / `binStepMax` | 80 / 125 |
| TVL range | `tvlMin` / `tvlMax` | 10k / 150k |
| Window volume floor | `volume24hMin` | 500 |
| Quote-token whitelist (XOR) | `includedTokens` | [SOL, USDC] |
| Excluded tokens | `excludedTokens` | [] |
| OKX risk score max | `okxRiskScoreMax` | 70 |
| Token all-time fees min | `minTokenFeesSol` | 30 SOL |
| Bundled holders max | `maxBundlersPct` | 30 |
| Top-10 holders max | `maxTop10Pct` | 60 |
| Blocked launchpads | `blockedLaunchpads` | [] |
| Smart-money net flow min | `smartMoneyNetFlowUsdMin` | 0 |
| Require mint/freeze authority off | `requireMint/FreezeAuthorityDisabled` | false |

**XOR whitelist**: pool passes when EXACTLY ONE side is a quote token — surfaces
`MEME/SOL`, `MEME/USDC` but rejects `SOL-USDC` (no memecoin side). OKX/smart-money
gates are pass-through ("informational") when OKX data is unavailable — missing
data is NOT treated as zero risk.

> **Data-window note:** `fetchAllPairs` (screening list) now uses the Meteora
> **Pool Discovery API** (`pool-discovery-api.datapi.meteora.ag/pools`) with
> `timeframe` + `category` from config (default `5m` / `trending`). The returned
> scalar `volume` / `fee` are totals for that window and populate
> `Pool.volume24h` / `Pool.fees24h` (field names kept; values are now 5m).
> `fetchPairByAddress` (manager/learning single-pool detail) still uses the
> `dlmm.datapi.meteora.ag` detail API. `filters.feeActiveTvlRatioMin` follows
> Meridian units: `0.05` means `0.05%` of active TVL in the configured window.

---

## Position Lifecycle (`manager.agent.ts`)

1. **Open** — `manager.open({ poolAddress, sizeUsd, rangeBps, dryRun })` via `meteora-actions`; tracked in `positions.json`
2. **Manage** (cron `manager.cron`) — `position-evaluator` computes in-range %, claimable fees, PnL → action
3. **Actions** — `ManagerActionKind`: `hold | claim | close | rebalance | skip | error`; thresholds in `manager.thresholds`
4. **Close** — outcome → `closed-positions.json`; learning `OutcomeCollector` + `LessonMiner` run

Size/range safety overrides on auto-open: by default `manager.deployAmountSol`,
`positionSizePct`, `maxDeployAmount`, `gasReserve`, and `minSolToOpen` size new
positions from wallet SOL balance. `manager.positionSizeUsd` is still available
as an explicit hard USD override. `manager.defaultRangeBps` acts as fallback AND
hard cap (Solana realloc limit makes large ranges risky).

---

## Config System

`config.ts` loads `user-config.json` (Zod-validated) once; `${ENV}` placeholders
expand from `.env`. `ConfigWatcher` hot-reloads on file change: filters/thresholds/
cron apply live (cron reschedules); RPC/API-keys/LLM-provider changes only update
in-memory value and log a "restart required" warning.

**Sanity gate**: `learning.mode="shadow"` requires `dryRun=true`. Live trading
(`dryRun=false`) with shadow mode → refuses to start (prevents "thought I was
observing but deployed real capital").

Top-level sections: `rpc`, `meteora`, `meteoraPnl`, `jupiter`, `okx`, `llm`,
`scheduler`, `filters`, `output`, `dryRun`, `websocket`, `manager`, `capital`,
`learning`, `memory`. Current: `scheduler.screenCron="*/30 * * * *"`,
`manager.cron="*/10 * * * *"`, `llm.provider="Codex-cli"` model `sonnet`,
`dryRun=true` (observation period), `learning.mode="active"`.

---

## Learning Loop & Memory

- **Decisions** recorded to `learning-decisions.jsonl`; outcomes computed at
  horizons `[10,30,120,360]` min → `learning-outcomes.jsonl`.
- **ShadowRanker** scores each decision against recency-weighted cohort evidence
  (`minEvidenceForScore=5`); LLM/shadow disagreement is journaled as `SHADOW_DISAGREEMENT`.
- **LessonMiner** derives lessons from closed-position cohorts → `learning-lessons.jsonl`.
- **DecisionJournal** (`decision-journal.jsonl`) is append-only memory; `MemoryRouter`
  injects relevant journal+lesson+evidence bundles into screener/manager prompts.
  Decisions cite `journalId` / `lessonId` in their reasons.

---

## Data Files (config.output.dataDir, default ./data)

| File | Writer |
|---|---|
| `candidates.jsonl` | Screener (per cycle, pre_llm + final) |
| `llm-runs.jsonl` | Screener (per LLM call: tokens, latency, cost, decision) |
| `progress.jsonl` | Screener + Manager (cycle progress events) |
| `decision-journal.jsonl` | All actors (append-only memory) |
| `learning-*.jsonl` | Learning loop |
| `realtime-signals.json` | RealtimeListener (bounded rolling snapshot) |
| `positions.json` / `closed-positions.json` | Tracker / ClosedStore |
| `decision-log.json` | Legacy array log (review/dashboard compat) |
| `commands.jsonl` | Telegram/web → bot command intake |

Web dashboard (`web/`) is strictly read-only; "Close Position" button is a no-op.

---

## Environment Variables

| Var | Required | Purpose |
|---|---|---|
| `HELIUS_API_KEY` | yes | RPC + Enhanced WS |
| `HELIUS_RPC_URL` / `HELIUS_WS_URL` | no | Override RPC/WS URLs |
| `LLM_PROVIDER` | no | Provider override: `Codex-cli` or `mimo` |
| `MIMO_API_KEY` / `MIMO_BASE_URL` / `MIMO_MODEL` | if provider=mimo | HTTP LLM config |
| `LLM_MODEL` | no | Override HTTP provider model |
| `PRIVATE_KEY_BOT` | for live trading | Base58 wallet secret |
| `JUPITER_API_KEY` | no | Higher Jupiter limits |
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` / `OKX_PROJECT_ID` | no | Signed OKX requests (public works without) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | no | Notifications + control center |
| `DRY_RUN` | no | `true` disables on-chain side effects |
| `LOG_LEVEL` | no | trace/debug/info/warn/error |

Secrets live in `.env`, never in `user-config.json` or `.mcp.json`.

---

## Conventions / Workflow

- ESM + `.js` import specifiers (NodeNext); no `any` in app code; Zod at boundaries.
- External-API tools never throw on enrichment failures — best-effort, log + fall back to raw.
- Before completing: `npm run typecheck` → `npm test` → `npm run build`.
- `dryRun` and the shadow/live sanity gate are the primary safety knobs — never
  flip to live (`dryRun=false`) without explicit operator intent.
- Heartbeat watchdog (cli.ts) re-registers a cron if it goes silent > 2.5× its interval.

---

## Differences vs Meridian (`yunus-0x/meridian`)

| Aspect | Meridian | This bot |
|---|---|---|
| Language | JS, single-file modules | TypeScript, layered (agents/tools/llm/learning/memory) |
| LLM control | ReAct tool-calling loop, role tool-sets | Fixed pipeline; LLM only emits a JSON decision (no tool calls) |
| Provider | HTTP LLM | Codex-cli or mimo |
| Screening window | `timeframe: "5m"`, category `trending` | `timeframe: "5m"` + `trending` via Pool Discovery API |
| Learning | `lessons.js` evolves thresholds | Full shadow/active loop: outcomes, cohort evidence, shadow ranker, lesson miner |
| Memory | pool-memory, strategy-library | append-only decision journal + memory router into prompts |
| Config reload | `update_config` tool restarts cron | file watcher hot-reload + restart-required warnings |
| Dashboard | Telegram only | Telegram control center + read-only Next.js web dashboard |
| Safety | executor pre-deploy checks | hard filters + confidence gate + dryRun + shadow/live sanity gate + phantom cleanup |
```
