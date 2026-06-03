# AI Learning System Comparison: Meridian vs Our Bot

> **Facts (GateGuard gate):**
> 1. No code file calls this — standalone documentation only
> 2. No existing file serves this purpose (docs/ directory was just created empty)
> 3. No data I/O — pure markdown documentation
> 4. User instruction: "coba pelajari https://github.com/yunus-0x/meridian bagaimana cara training ai dan bandingkan dengan bot kita"

---

## Executive Summary

Neither system fine-tunes an LLM. Both inject past decisions/outcomes/lessons as
**prompt context**. Meridian is more adaptive (auto-mutates config, per-pool memory,
cross-instance HiveMind). Our bot has stronger statistical rigor (multi-horizon
outcomes, ShadowRanker meta-learning, Zod-validated fixed pipeline).

| Dimension | Meridian | Our Bot |
|---|---|---|
| Lesson injection | 3-tier priority (pinned / role / recent), cap ~35 | CohortLessonMiner + LessonStore; flat list via MemoryRouter |
| Threshold evolution | Auto-rewrites `user-config.json` every 5 closes | No auto-mutation; lessons are descriptive only |
| Pool memory | Per-pool deploy history + cooldowns + snapshots | EvidenceIndex (feature-band cohorts); no per-pool address tracking |
| LLM architecture | ReAct tool-calling loop; LLM calls tools dynamically | Fixed pipeline; one prompt → Zod-validated JSON decision |
| Meta-learning | None | ShadowRanker flags LLM/cohort disagreement |
| Cross-instance | HiveMind API (push/pull lessons across bots) | Single-instance only |
| Outcome horizons | Single-point at position close | 4 horizons: 10m / 30m / 120m / 360m |

---

## 1. Lesson System

### Meridian (`lessons.js`)

```js
// Lesson shape
{
  id, rule, tags, outcome, confidence,
  pinned, role, sourceType, created_at
}
```

**Generation:**
- `recordPerformance()` on every position close (only "good" or "bad" outcomes → `rule` auto-derived)
- `addLesson()` for manual operator annotations
- Threshold evolution: every 5 closes → auto-rewrites `user-config.json` with new thresholds

**Injection (`getLessonsForPrompt()`):**
1. **Tier 1 — Pinned**: 5–10 hard-wired rules that always appear
2. **Tier 2 — Role-matched**: lessons matching current agent role (screener / manager)
3. **Tier 3 — Recent fill-up**: most-recent non-duplicate lessons until ~35 total
4. Concatenated into `LESSONS` block in system prompt

### Our Bot (`lesson-miner.ts` + `lesson-store.ts` + `memory-router.ts`)

**Generation:**
- `LessonMiner.mine()` — two sources:
  - Cohort buckets (feature-band aggregates from EvidenceIndex)
  - Closed-position reviews (outcome > 2× / < 0.5× expected → lesson)
- Jaccard dedup at 0.7 threshold
- Idempotent (safe to re-run; won't duplicate)

**Injection (`MemoryRouter`):**
- `forScreener()` → `{ recentDecisions, lessons, learningEvidence }`
- `forManager()` → same, manager-scoped
- `forPostMortem()` → full bundle for post-mortem prompt
- Flat list injected; no tier priority

**Gap:** No pinned/role tier → important rules can fall off when lesson list is long.

---

## 2. Threshold Evolution

### Meridian

After every 5 closed positions, Meridian calls `evolveThresholds()`:
- Reads current closed-position stats
- Computes new `minFeeRatio`, `minHolders`, `maxRiskScore` etc.
- **Directly mutates `user-config.json`** on disk
- Next screen cycle picks up new values automatically (config hot-reload)

This is autonomous threshold adaptation — the bot tunes itself without operator input.

### Our Bot

No auto-mutation. Lessons are descriptive strings ("avoid bins > 100 when vol/TVL < 0.02").
Operator must manually update `user-config.json` based on dashboard review.

**Gap:** No automatic threshold suggestion. LessonMiner could emit `suggestedThresholds`
objects instead of free-text rules. ConfigWatcher already supports hot-reload — the
plumbing exists; we just need the suggestion engine.

---

## 3. Pool Memory

### Meridian (`pool-memory.js`)

Per-pool address tracking:
```js
{
  address,
  deploys: [ { pnlPct, feesEarned, rangeEfficiency, closeReason, strategy } ],
  totalDeploys, avgPnl, winRate, adjustedWinRate,
  snapshots: [ ...48 live 5-min snapshots (~4h) ],
  cooldown: { until, reason },
  tokenCooldown: { [tokenMint]: { until, reason } },
  annotations: "freeform 280-char notes"
}
```

`recallForPool(address)` injects before any deployment:
- Aggregate stats (avg PnL, win rate)
- Cooldown status (skip if active)
- 6-snapshot trend (last 30 min vol/fee movement)

Cooldowns prevent re-entering a pool that just lost money.

### Our Bot (`evidence-index.ts`)

Feature-band cohorts (NOT per-pool):
```ts
key = `${binStepBand}:${feeTvlBand}:${volTvlBand}:${riskFlagsCount}`
```

Cohort scoring: recency-weighted (14-day half-life), horizon weights 0.3/0.5/0.8/1.0.
No per-pool address history. No cooldown mechanism.

**Gap (HIGH PRIORITY):** If a pool rug-pulled or repeatedly lost money, our bot can
re-enter it on the next cycle. Meridian's pool memory + cooldown prevents this entirely.

**Recommended addition:**
```ts
// src/memory/pool-memory.ts
interface PoolMemoryEntry {
  address: string;
  deploys: DeployRecord[];
  cooldownUntil?: number;
  tokenCooldownUntil?: Record<string, number>;
}
```

---

## 4. LLM Architecture

### Meridian — ReAct Tool-Calling Loop

LLM is the **active orchestrator**. On each screening turn, the LLM:
1. Receives pool data + system prompt
2. **Calls tools dynamically** (`recall_pool_memory`, `get_recent_decisions`, `update_config`, etc.)
3. Iterates until it produces a final decision

Tools available to the LLM:
- `recall_pool_memory(address)` — fetch per-pool stats
- `get_recent_decisions(role)` — last N decisions
- `update_config(key, value)` — mutate config live
- `add_lesson(rule, tags)` — inject new lessons mid-session

**Pros:** Flexible, can chain lookups, self-correcting.  
**Cons:** Unpredictable token usage, hard to validate, tool-call loops can spiral.

### Our Bot — Fixed Pipeline JSON Decision

LLM is a **stateless classifier**. Pipeline:
1. `MemoryRouter` assembles full context (journal + lessons + evidence)
2. One prompt sent; LLM returns one JSON object
3. Zod `DecisionSchema` validates before use
4. Any invalid JSON → decision skipped (logged, never crashes pipeline)

Decision shape:
```ts
{
  action: "ENTER" | "WATCH" | "SKIP",
  confidence: 0..1,
  reasons: string[],
  risks: string[],
  suggestedSizeUsd?: number,
  suggestedRangeBps?: number,
  notes?: string
}
```

**Pros:** Deterministic, auditable, type-safe, cost-bounded.  
**Cons:** LLM can't request additional context mid-decision.

---

## 5. ShadowRanker (Our Exclusive)

Meridian has no equivalent.

Our `ShadowRanker` is a **meta-learning layer** that observes whether the LLM agrees
with cohort evidence:

```ts
// Disagreement detection
if (action === "ENTER" && expectedScore < -0.1)  → SHADOW_DISAGREEMENT (LLM bullish, data bearish)
if (action === "SKIP"  && expectedScore > 0.2)   → SHADOW_DISAGREEMENT (LLM bearish, data bullish)
```

Disagreements are journaled. Over time, this reveals systematic LLM biases that
can be addressed via prompt updates or lesson additions.

Requires `minEvidenceForScore=5` cohort samples before firing.

---

## 6. HiveMind (Meridian Exclusive)

Meridian's `hivemind.js` enables **cross-instance lesson sharing**:

- **Pull** (`GET /api/hivemind/lessons/pull`): every 15 min, fetch up to 6 lessons from shared pool, filtered by role
- **Push** (`POST /api/hivemind/lessons/push`): on position close, submit rule/tags/PnL/fees
- Authentication via API key
- Aggregate confidence from multiple instances

**Effect:** A fleet of Meridian bots collectively learns. One bot's loss prevents
another bot's identical mistake.

Our bot is single-instance only. No cross-bot learning.

**Potential addition:** Our `DecisionJournal` format is JSONL — straightforward to
expose via a REST endpoint for multi-instance sync. Lower priority than pool memory.

---

## 7. Multi-Horizon Outcomes (Our Advantage)

### Meridian
Single outcome at position close. `recordPerformance()` fires once.
No time-segmented view of how a pool performs at 10 min vs 6 hours.

### Our Bot (`outcome-collector.ts`)
Four measurement horizons: **10m / 30m / 120m / 360m**

```ts
HORIZON_MINUTES = [10, 30, 120, 360]
```

Horizon weights in EvidenceIndex: `0.3 / 0.5 / 0.8 / 1.0` (longer horizon = more signal).

This enables distinguishing:
- Pump-and-dump patterns (good at 10m, bad at 360m)
- Slow-build pools (mediocre at 10m, excellent at 360m)

---

## 8. Gap Analysis & Action Items

### Priority 1 — Pool Memory + Cooldowns

**Why:** Prevents re-entering known bad pools. Highest practical impact.

```
New file: src/memory/pool-memory.ts
- PoolMemoryStore: tracks per-address deploys, PnL, cooldowns
- PositionTracker calls recordDeploy() on open, recordClose() on close
- ManagerAgent checks hasCooldown(address) before rebalance/re-enter
- MemoryRouter.forScreener() injects recallForPool() stats
```

### Priority 2 — Lesson Tiering

**Why:** Critical rules (e.g., "never enter without OKX score") can fall off prompt.

```
Extend lesson-store.ts:
- Add pinned: boolean, role: "screener" | "manager" | "both" fields
- Modify MemoryRouter to implement 3-tier injection (pinned → role → recent)
```

### Priority 3 — Threshold Suggestion Engine

**Why:** Currently human must read dashboard to tune filters; bot could suggest.

```
Extend lesson-miner.ts:
- After 5+ closed positions, compute suggestedThresholds: FilterConfig delta
- Emit to a separate lessons-thresholds.jsonl
- Dashboard shows diffs; operator can apply with one click (not auto-applied)
```

### Priority 4 — Pool-Level Disagreement Tracking

**Why:** ShadowRanker currently journals individual decisions; surfacing per-pool
patterns would let us see "this pool consistently triggers LLM/cohort disagreement".

---

## Summary

Our bot has **stronger statistical rigor** (multi-horizon, ShadowRanker, Zod pipeline).
Meridian has **stronger operational memory** (per-pool tracking, cooldowns, auto-threshold evolution, HiveMind).

The highest-leverage improvement is **Priority 1: pool memory + cooldowns**, which
directly prevents known-bad re-entries and mirrors Meridian's most practical feature.
