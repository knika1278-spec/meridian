import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cron, { type ScheduledTask } from "node-cron";
import { z } from "zod";

import type {
  UserConfig,
  ScreeningResult,
  ScreenerRunOptions,
  Pool,
  TokenInfo,
  FilterReportEntry,
  RealtimeEvent,
  LLMDecision,
  RealtimeEventKind,
  PromptMemoryBundle,
  ShadowScore,
  DeployGateAudit,
  DeployGateAuditStatus,
} from "../types/index.js";
import { childLogger, type Logger } from "../utils/logger.js";
import type { DecisionLogger } from "../utils/decision-logger.js";
import type { JsonlEmitter } from "../utils/jsonl-emitter.js";
import type { MeteoraTools } from "../tools/meteora.tools.js";
import type { JupiterTools } from "../tools/jupiter.tools.js";
import type { OkxTools } from "../tools/okx.tools.js";
import type { RealtimeListener } from "./realtime.listener.js";
import type { ManagerAgent } from "./manager.agent.js";
import { createLlmProvider } from "../llm/factory.js";
import type { LlmProvider } from "../llm/types.js";
import type { LearningRecorder } from "../learning/recorder.js";
import type { ShadowRanker } from "../learning/shadow-ranker.js";
import { readSignalWeightsPromptHints } from "../learning/signal-weights.js";
import type { DecisionJournal } from "../memory/decision-journal.js";
import type { MemoryRouter } from "../memory/memory-router.js";
import { hasPromptMemory } from "../memory/memory-router.js";
import type { BlacklistStore } from "./blacklist-store.js";
import type { PoolMemoryStore } from "./pool-memory-store.js";
import { ProgressReporter, type ProgressSink } from "../utils/progress.js";
import { toDashboardPoolCandidate } from "../shared/dashboard-contract.js";
import {
  clampSuggestedRangeBps,
  rangeGuidanceForBinStep,
} from "../utils/range-guard.js";
import {
  buildEntrySnapshot,
  evaluateCollapseGuard,
  evaluateEntryPolicy,
  scoreEnterCandidate,
  selectTopEnterCandidates,
} from "../utils/entry-policy.js";
import type { BotCommand } from "../utils/command-consumer.js";
import { Semaphore } from "async-mutex";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SYSTEM_PROMPT_PATH = path.resolve(
  __dirname,
  "../../prompts/screener.system.md",
);

const DecisionSchema = z.object({
  action: z.enum(["ENTER", "WATCH", "SKIP"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  risks: z.array(z.string()),
  suggestedSizeUsd: z.number().optional(),
  suggestedRangeBps: z.number().optional(),
  notes: z.string().optional(),
});

const DEFAULT_LLM_CONCURRENCY = 3;
const DEFAULT_LLM_TIMEOUT_MS = 180_000;
const DEFAULT_ONCHAIN_CONCURRENCY = 3;
const DEFAULT_ENRICH_OUTER_CONCURRENCY = 15;
const DEFAULT_FETCH_LIMIT = 200;
const DEFAULT_FALLBACK_SIZE_USD = 200;
const DEFAULT_FALLBACK_RANGE_BPS = 500;

export interface ScreenerDeps {
  meteora: MeteoraTools;
  jupiter: JupiterTools;
  okx?: OkxTools;
  decisionLogger: DecisionLogger;
  listener?: RealtimeListener;
  /** When provided, ENTER decisions auto-trigger `manager.open(...)`. */
  manager?: ManagerAgent;
  /** Optional append-only JSONL emitters for the web bridge. */
  candidatesEmitter?: JsonlEmitter;
  llmRunsEmitter?: JsonlEmitter;
  progressEmitter?: JsonlEmitter;
  /** Optional command queue for split-process manager handoff. */
  commandEmitter?: JsonlEmitter;
  onProgress?: ProgressSink;
  /** Optional learning recorder â€" records screener decisions for the learning loop. */
  learningRecorder?: LearningRecorder;
  /** Optional shadow ranker â€" scores each recorded decision against cohort evidence. */
  shadowRanker?: ShadowRanker;
  /** Optional append-only decision journal. Failures never block trading cycles. */
  decisionJournal?: DecisionJournal;
  /** Optional prompt memory router backed by journal + lessons + learning evidence. */
  memoryRouter?: MemoryRouter;
  /** Optional blacklist store — pools whose tokens are blacklisted are hard-rejected. */
  blacklistStore?: BlacklistStore;
  /** Optional pool-memory store — pools on cooldown after recent close are hard-rejected. */
  poolMemoryStore?: PoolMemoryStore;
  /** Optional sink invoked with the results of each auto (cron) cycle. */
  onCycleComplete?: (results: ScreeningResult[]) => void;
}

export class ScreenerAgent {
  private config: UserConfig;
  private readonly deps: ScreenerDeps;
  private readonly log: Logger;
  private readonly systemPrompt: string;
  private readonly llm: LlmProvider;

  private cronTask: ScheduledTask | null = null;
  private running = false;
  private lastCycleAt: number | null = null;

  constructor(config: UserConfig, deps: ScreenerDeps) {
    this.config = config;
    this.deps = deps;
    this.log = childLogger("screener");
    this.systemPrompt = this.loadSystemPrompt();
    this.llm = createLlmProvider(config.llm);
    this.log.info(
      { provider: this.llm.name, model: this.llm.model },
      "llm provider initialized",
    );
  }

  async runOnce(opts: ScreenerRunOptions = {}): Promise<ScreeningResult[]> {
    if (this.running) {
      this.log.warn("screener cycle already running; skipping overlapping run");
      return [];
    }
    this.running = true;
    try {
      const cycleId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const limit = opts.limit ?? this.config.meteora.fetchLimit ?? DEFAULT_FETCH_LIMIT;
      const progress = new ProgressReporter({
        source: "SCREENER",
        cycleId,
        emitter: this.deps.progressEmitter,
        sink: this.deps.onProgress,
        commandId: opts.commandId,
      });
      progress.emit({
        phase: "cycle",
        percent: 0,
        message: `Starting screener cycle, limit ${limit}`,
        total: limit,
      });
      this.log.info({ cycleId, limit }, "screener cycle starting");

      let candidates: Pool[] = [];
      try {
        progress.emit({
          phase: "fetch",
          percent: 5,
          message: `Fetching Meteora pools (${this.config.meteora.timeframe}/${this.config.meteora.category})`,
          total: limit,
        });
        candidates = await this.deps.meteora.fetchAllPairs({
          limit,
          sortBy: "fees_24h",
          filters: this.config.filters,
        });
      } catch (err) {
        this.log.error({ err }, "failed to fetch candidate pools");
        progress.emit({
          phase: "fetch",
          status: "failed",
          percent: 100,
          message: "Failed to fetch candidate pools",
          detail: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
      progress.emit({
        phase: "fetch",
        percent: 15,
        message: `Fetched ${candidates.length} candidate pools`,
        current: candidates.length,
        total: candidates.length,
      });
      this.log.info(
        { cycleId, count: candidates.length },
        "fetched candidates",
      );

      const enriched = await this.enrichAll(candidates, progress);
      const results = enriched.map((pool) => this.buildResult(pool, cycleId));
      const passedAfterFilters = results.filter((r) => r.filtersPassed).length;
      progress.emit({
        phase: "filters",
        percent: 48,
        message: `${passedAfterFilters}/${results.length} pools passed hard filters`,
        current: passedAfterFilters,
        total: results.length,
      });
      this.emitCandidatesSnapshot(cycleId, results, "pre_llm");

      const useLlm = this.config.llm.enabled && opts.useLlm !== false;
      if (useLlm) {
        await this.enrichActiveBins(results, progress);
        await this.runLlmBatch(results, progress);
        await this.autoOpenEnterDecisions(results, cycleId);
        progress.emit({
          phase: "executor",
          percent: 90,
          message: "Auto-open/no-deploy checks complete",
        });
      } else {
        progress.emit({
          phase: "llm",
          status: "skipped",
          percent: 82,
          message: "LLM disabled for this screener cycle",
        });
      }

      // Persist results that passed filters
      const dryRun = this.config.dryRun || !!opts.dryRunOverride;
      progress.emit({
        phase: "persist",
        percent: 92,
        message: "Persisting decisions and learning evidence",
      });
      for (const r of results) {
        if (!r.filtersPassed) continue;
        try {
          this.deps.decisionLogger.append(r, dryRun);
        } catch (err) {
          this.log.warn(
            { err, pool: r.pool.address },
            "failed to persist decision",
          );
        }
        this.recordScreenDecision(r, dryRun);
      }

      if (this.deps.learningRecorder) {
        for (const r of results) {
          if (!r.filtersPassed) continue;
          let recorded: ReturnType<LearningRecorder["recordScreener"]> = null;
          try {
            recorded = this.deps.learningRecorder.recordScreener(r, cycleId);
          } catch (err) {
            this.log.warn(
              { err, pool: r.pool.address },
              "learning recorder failed",
            );
          }
          if (recorded && this.deps.shadowRanker) {
            try {
              const shadowScore = this.deps.shadowRanker.score(recorded);
              if (shadowScore?.disagreement) {
                this.recordShadowDisagreement(r, recorded.id, shadowScore);
              }
            } catch (err) {
              this.log.warn(
                { err, pool: r.pool.address },
                "shadow ranker failed",
              );
            }
          }
        }
      }

      const passed = results.filter((r) => r.filtersPassed).length;

      this.emitCandidatesSnapshot(cycleId, results, "final");

      this.log.info(
        { cycleId, total: results.length, passed },
        "screener cycle complete",
      );
      progress.emit({
        phase: "complete",
        status: "success",
        percent: 100,
        message: `Screener complete: ${results.length} evaluated, ${passed} passed`,
        current: results.length,
        total: results.length,
      });
      return results;
    } finally {
      this.lastCycleAt = Date.now();
      this.running = false;
    }
  }

  startAuto(): void {
    if (this.cronTask) {
      this.log.warn("startAuto called but cron already running");
      return;
    }
    const expr = this.config.scheduler.screenCron;
    if (!cron.validate(expr)) {
      this.log.error(
        { expr },
        "invalid cron expression; auto mode not started",
      );
      return;
    }
    this.cronTask = cron.schedule(expr, () => {
      this.runOnce()
        .then((results) => this.deps.onCycleComplete?.(results))
        .catch((err) => this.log.error({ err }, "cron cycle error"));
    });
    this.log.info({ expr }, "screener auto mode started");
  }

  stopAuto(): void {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
      this.log.info("screener auto mode stopped");
    }
  }

  /**
   * Apply a hot-reloaded config snapshot. Re-schedules the cron if the
   * `screenCron` expression changed and warns when fields that require a
   * full process restart were modified (RPC, API keys, LLM provider, etc.).
   */
  updateMutableConfig(next: UserConfig): void {
    const prev = this.config;
    const changedKeys = shallowTopLevelDiff(
      prev as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
    );

    // ---- detect non-hot-reloadable changes and warn ----
    const restartRequired: string[] = [];
    if (
      prev.rpc.url !== next.rpc.url ||
      prev.rpc.wsUrl !== next.rpc.wsUrl ||
      prev.rpc.commitment !== next.rpc.commitment
    ) {
      restartRequired.push("rpc.*");
    }
    if (prev.jupiter.apiKey !== next.jupiter.apiKey) {
      restartRequired.push("jupiter.apiKey");
    }
    if (prev.okx.apiKey !== next.okx.apiKey) {
      restartRequired.push("okx.apiKey");
    }
    if (prev.meteora.programId !== next.meteora.programId) {
      restartRequired.push("meteora.programId");
    }
    if (prev.meteora.apiUrl !== next.meteora.apiUrl) {
      restartRequired.push("meteora.apiUrl");
    }
    if (prev.meteora.timeframe !== next.meteora.timeframe) {
      restartRequired.push("meteora.timeframe");
    }
    if (prev.meteora.category !== next.meteora.category) {
      restartRequired.push("meteora.category");
    }
    if (prev.llm.provider !== next.llm.provider) {
      restartRequired.push("llm.provider");
    }
    if (restartRequired.length > 0) {
      this.log.warn(
        { restartRequired },
        "config fields changed that require a process restart; in-memory value updated but live behavior unchanged",
      );
    }

    this.config = next;

    // ---- cron reschedule when expression changed ----
    if (
      this.cronTask &&
      prev.scheduler.screenCron !== next.scheduler.screenCron
    ) {
      this.log.info(
        {
          prev: prev.scheduler.screenCron,
          next: next.scheduler.screenCron,
        },
        "cron rescheduled",
      );
      this.stopAuto();
      this.startAuto();
    }

    this.log.info({ changedKeys }, "screener config hot-reloaded");
  }

  // ---------- internals ----------

  private loadSystemPrompt(): string {
    try {
      return fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
    } catch (err) {
      this.log.error(
        { err, path: SYSTEM_PROMPT_PATH },
        "failed to read system prompt",
      );
      return "You are an LLP screener. Output a JSON object with action, confidence, reasons, risks.";
    }
  }

  private async enrichAll(
    pools: Pool[],
    progress?: ProgressReporter,
  ): Promise<Pool[]> {
    const out: Pool[] = [];
    let completed = 0;
    const total = pools.length;
    progress?.emit({
      phase: "enrichment",
      percent: 18,
      message: `Enriching ${total} pools with token, risk, and smart-money data`,
      current: 0,
      total,
    });
    const sem = new Semaphore(this.config.meteora.enrichConcurrency ?? DEFAULT_ENRICH_OUTER_CONCURRENCY);
    const tasks = pools.map((pool) =>
      sem.runExclusive(async () => {
        try {
          const [tokenX, tokenY] = await Promise.all([
            this.enrichToken(pool.tokenX.mint),
            this.enrichToken(pool.tokenY.mint),
          ]);
          return {
            ...pool,
            tokenX: mergeTokenInfo(pool.tokenX, tokenX),
            tokenY: mergeTokenInfo(pool.tokenY, tokenY),
          };
        } catch (err) {
          this.log.warn(
            { err, pool: pool.address },
            "enrichment failed for pool; using raw",
          );
          return pool;
        } finally {
          completed++;
          if (shouldEmitProgress(completed, total)) {
            progress?.emit({
              phase: "enrichment",
              percent: 18 + (completed / Math.max(1, total)) * 24,
              message: `Enriched ${completed}/${total} pools`,
              current: completed,
              total,
              poolAddress: pool.address,
              poolName: pool.name,
            });
          }
        }
      }),
    );
    const settled = await Promise.allSettled(tasks);
    for (const s of settled) {
      if (s.status === "fulfilled") out.push(s.value);
    }
    progress?.emit({
      phase: "enrichment",
      percent: 44,
      message: `Token enrichment complete for ${out.length}/${total} pools`,
      current: out.length,
      total,
    });
    return out;
  }

  /**
   * Combine Jupiter token info (incl. audit, launchpad, price stats) with
   * OKX risk + smart-money signals when the OKX connector is enabled. Both
   * lookups are best-effort and run in parallel.
   */
  private async enrichToken(mint: string): Promise<Partial<TokenInfo>> {
    const okx = this.deps.okx;
    const [jupInfo, okxRisk, okxSmart] = await Promise.all([
      this.deps.jupiter.getTokenInfo(mint).catch((err) => {
        this.log.debug({ err, mint }, "jupiter token info failed");
        return {} as Partial<TokenInfo>;
      }),
      okx?.isEnabled()
        ? okx.getTokenRisk(mint).catch(() => undefined)
        : Promise.resolve(undefined),
      okx?.isEnabled()
        ? okx.getSmartMoneySignals(mint).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);

    const out: Partial<TokenInfo> = { ...jupInfo };
    if (okxRisk && okx?.hasUsefulRiskData(okxRisk)) {
      out.risk = { ...okxRisk };
    }
    if (okxSmart && okx?.hasUsefulSmartData(okxSmart)) {
      out.smartMoney = {
        ...(okxSmart.available !== undefined
          ? { available: okxSmart.available }
          : {}),
        ...(okxSmart.source ? { source: okxSmart.source } : {}),
        lastSignalsCount: okxSmart.lastSignals.length,
        ...(okxSmart.netFlowUsd !== undefined
          ? { netFlowUsd: okxSmart.netFlowUsd }
          : {}),
        ...(okxSmart.buyersCount !== undefined
          ? { buyersCount: okxSmart.buyersCount }
          : {}),
        ...(okxSmart.sellersCount !== undefined
          ? { sellersCount: okxSmart.sellersCount }
          : {}),
        ...(okxSmart.smartMoneyBuy !== undefined
          ? { smartMoneyBuy: okxSmart.smartMoneyBuy }
          : {}),
        ...(okxSmart.kolInClusters !== undefined
          ? { kolInClusters: okxSmart.kolInClusters }
          : {}),
        ...(okxSmart.topClusterTrend
          ? { topClusterTrend: okxSmart.topClusterTrend }
          : {}),
        ...(okxSmart.topClusterHoldPct !== undefined
          ? { topClusterHoldPct: okxSmart.topClusterHoldPct }
          : {}),
      };
    }
    return out;
  }

  private buildResult(pool: Pool, cycleId: string): ScreeningResult {
    const filterReport = this.applyFilters(pool);

    // Compute realtime signals first so the activity gate can reference them.
    const realtimeSignals: RealtimeEvent[] =
      this.deps.listener?.recentFor(pool.address, 20) ?? [];

    // Optional hard gate: reject pools with zero recent on-chain activity.
    // All confirmed losses had recentSignals:[] — dead pools that passed fee
    // filters on stale 5m candles but had no live swap/liquidity events.
    // Only applied when the WS listener is active (listener present); if WS is
    // not running the signal buffer is always empty and this would block everything.
    if (this.config.filters.requireRecentActivity && this.deps.listener) {
      filterReport.recentActivity = {
        value: realtimeSignals.length,
        threshold: ">0 events",
        passed: realtimeSignals.length > 0,
      };
    }

    const entryPolicy = evaluateEntryPolicy(
      realtimeSignals,
      this.config.entryPolicy,
    );
    if (this.config.entryPolicy.enabled) {
      filterReport.entryPolicy = {
        value: entryPolicy.passed
          ? "passed"
          : (entryPolicy.reasonCode ?? "failed"),
        threshold: "realtime-confirmed-entry",
        passed:
          this.config.entryPolicy.mode === "observe"
            ? true
            : entryPolicy.passed,
      };
    }

    const filtersPassed = Object.values(filterReport).every((e) => e.passed);
    return {
      pool,
      filtersPassed,
      filterReport,
      realtimeSignals,
      entryPolicy,
      timestamp: Date.now(),
      cycleId,
    };
  }

  private applyFilters(pool: Pool): Record<string, FilterReportEntry> {
    const f = this.config.filters;
    const report: Record<string, FilterReportEntry> = {};

    // Blacklist gate — hard reject if either token mint is blacklisted.
    const tokenMints = [pool.tokenX.mint, pool.tokenY.mint];
    const blacklisted = tokenMints.find((mint) =>
      this.deps.blacklistStore?.isBlacklisted(mint),
    );
    report.blacklist = {
      value: blacklisted ?? "none",
      threshold: "not-blacklisted",
      passed: !blacklisted,
    };

    // Pool cooldown gate — hard reject if pool was recently closed.
    const onCooldown =
      this.deps.poolMemoryStore?.isOnCooldown(pool.address) ?? false;
    report.poolCooldown = {
      value: onCooldown ? "on-cooldown" : "clear",
      threshold: `cooldown:${this.config.memory?.poolCooldownHours ?? 24}h`,
      passed: !onCooldown,
    };

    const activeTvl = Math.max(pool.activeTvl, 1);
    // Meridian-compatible units: fee/active-TVL is expressed in percentage
    // points, so 0.05 means 0.05% of active TVL during the active timeframe.
    const feeRatioPct = (pool.fees24h / activeTvl) * 100;
    report.feeActiveTvlRatio = {
      value: feeRatioPct,
      threshold: f.feeActiveTvlRatioMin,
      passed: feeRatioPct >= f.feeActiveTvlRatioMin,
    };

    // Quality gates (organic score, holders, market cap) screen the
    // SPECULATIVE token. Whitelisted quote assets (includedTokens, e.g.
    // SOL/USDC) are exempt â€" their mcap/holders dwarf the thresholds, so
    // applying these gates to the quote side would reject every memecoin/SOL
    // pair. The XOR check below still requires exactly one quote side, so the
    // non-quote side is the token actually being screened.
    const included = f.includedTokens ?? [];
    const xIsQuote = included.length > 0 && included.includes(pool.tokenX.mint);
    const yIsQuote = included.length > 0 && included.includes(pool.tokenY.mint);
    const screenedTokens = [
      { side: "tokenX", token: pool.tokenX, isQuote: xIsQuote },
      { side: "tokenY", token: pool.tokenY, isQuote: yIsQuote },
    ].filter((item) => !item.isQuote);
    const riskTargets =
      screenedTokens.length > 0
        ? screenedTokens.map((item) => item.token)
        : [pool.tokenX, pool.tokenY];
    const exemptEntry = (threshold: number | string): FilterReportEntry => ({
      value: "quote-exempt",
      threshold,
      passed: true,
    });

    report.tokenXOrganicScore = xIsQuote
      ? exemptEntry(f.organicScoreMin)
      : numericGate(pool.tokenX.organicScore, f.organicScoreMin, "min");
    report.tokenYOrganicScore = yIsQuote
      ? exemptEntry(f.organicScoreMin)
      : numericGate(pool.tokenY.organicScore, f.organicScoreMin, "min");

    report.tokenXHolders = xIsQuote
      ? exemptEntry(f.holdersMin)
      : numericGate(pool.tokenX.holders, f.holdersMin, "min");
    report.tokenYHolders = yIsQuote
      ? exemptEntry(f.holdersMin)
      : numericGate(pool.tokenY.holders, f.holdersMin, "min");

    report.tokenXMarketCap = xIsQuote
      ? exemptEntry(`${f.marketCapMin}..${f.marketCapMax}`)
      : rangeGate(pool.tokenX.marketCap, f.marketCapMin, f.marketCapMax);
    report.tokenYMarketCap = yIsQuote
      ? exemptEntry(`${f.marketCapMin}..${f.marketCapMax}`)
      : rangeGate(pool.tokenY.marketCap, f.marketCapMin, f.marketCapMax);

    report.binStep = rangeGate(pool.binStep, f.binStepMin, f.binStepMax);
    report.tvl = rangeGate(pool.tvl, f.tvlMin, f.tvlMax);

    if (typeof f.volume24hMin === "number") {
      report.volume24h = numericGate(pool.volume24h, f.volume24hMin, "min");
    }

    if (typeof f.minTokenFeesSol === "number") {
      const fees = riskTargets
        .map((token) => token.risk?.totalFeeSol)
        .filter(isFiniteNumber);
      const lowest = fees.length > 0 ? Math.min(...fees) : undefined;
      report.minTokenFeesSol = {
        value: lowest ?? "unavailable",
        threshold: f.minTokenFeesSol,
        passed: lowest === undefined || lowest >= f.minTokenFeesSol,
      };
    }

    if (typeof f.maxBundlersPct === "number") {
      const bundlePcts = riskTargets
        .map((token) => token.risk?.bundlePct)
        .filter(isFiniteNumber);
      const worst = bundlePcts.length > 0 ? Math.max(...bundlePcts) : undefined;
      report.maxBundlersPct = {
        value: worst ?? "unavailable",
        threshold: f.maxBundlersPct,
        passed: worst === undefined || worst <= f.maxBundlersPct,
      };
    }

    if (typeof f.maxTop10Pct === "number") {
      const top10Pcts = riskTargets
        .map((token) => token.risk?.topHoldersPct)
        .filter(isFiniteNumber);
      const worst = top10Pcts.length > 0 ? Math.max(...top10Pcts) : undefined;
      report.maxTop10Pct = {
        value: worst ?? "unavailable",
        threshold: f.maxTop10Pct,
        passed: worst === undefined || worst <= f.maxTop10Pct,
      };
    }

    if (f.blockedLaunchpads && f.blockedLaunchpads.length > 0) {
      const blocked = new Set(
        f.blockedLaunchpads.map((name) => name.trim().toLowerCase()),
      );
      const hit = riskTargets
        .map((token) => token.launchpad?.launchpad)
        .find((name) => name && blocked.has(name.trim().toLowerCase()));
      report.blockedLaunchpads = {
        value: hit ?? "none",
        threshold: "not-blocked",
        passed: hit === undefined,
      };
    }

    const excluded = f.excludedTokens ?? [];
    const exclusionHit =
      excluded.includes(pool.tokenX.mint) ||
      excluded.includes(pool.tokenY.mint);
    report.excludedTokens = {
      value: exclusionHit,
      threshold: "not-in-excluded",
      passed: !exclusionHit,
    };

    // Quote-token whitelist (XOR): pool passes when EXACTLY ONE token is
    // in the list. Use [SOL, USDC] to surface memecoin pairs (RICH/SOL,
    // HYPE/USDC, BONK/SOL, WIF/USDC) but REJECT pairs where both sides
    // are quote tokens (SOL-USDC fails â€" no memecoin side to play).
    if (f.includedTokens && f.includedTokens.length > 0) {
      const xIn = f.includedTokens.includes(pool.tokenX.mint);
      const yIn = f.includedTokens.includes(pool.tokenY.mint);
      report.includedTokens = {
        value: `X=${xIn} Y=${yIn}`,
        threshold: "exactly-one-quote-token (XOR)",
        passed: xIn !== yIn,
      };
    }

    // ---- OKX risk score ----
    if (typeof f.okxRiskScoreMax === "number") {
      const scores = [
        pool.tokenX.risk?.riskScore,
        pool.tokenY.risk?.riskScore,
      ].filter((score): score is number => typeof score === "number");
      const worst = scores.length > 0 ? Math.max(...scores) : undefined;
      report.okxRiskScore = {
        value: worst ?? "unavailable",
        threshold: f.okxRiskScoreMax,
        // No OKX data is not the same thing as zero risk. Keep this
        // pass-through and let the prompt surface "OKX unavailable".
        passed: worst === undefined || worst <= f.okxRiskScoreMax,
      };
    }

    const criticalOkxFlags = [
      ...tokenOkxCriticalFlags(pool.tokenX),
      ...tokenOkxCriticalFlags(pool.tokenY),
    ];
    if (
      criticalOkxFlags.length > 0 ||
      hasOkxData(pool.tokenX) ||
      hasOkxData(pool.tokenY)
    ) {
      report.okxCriticalRisk = {
        value:
          criticalOkxFlags.length > 0 ? criticalOkxFlags.join(", ") : "none",
        threshold: "no honeypot/wash",
        passed: criticalOkxFlags.length === 0,
      };
    }

    // ---- Smart-money net flow ----
    if (typeof f.smartMoneyNetFlowUsdMin === "number") {
      const xFlow = pool.tokenX.smartMoney?.netFlowUsd;
      const yFlow = pool.tokenY.smartMoney?.netFlowUsd;
      const flow = (xFlow ?? 0) + (yFlow ?? 0);
      const hasData = xFlow !== undefined || yFlow !== undefined;
      report.smartMoneyNetFlow = {
        value: hasData ? flow : "unavailable",
        threshold: f.smartMoneyNetFlowUsdMin,
        // If OKX is unavailable, treat the gate as informational (pass).
        passed: !hasData || flow >= f.smartMoneyNetFlowUsdMin,
      };
    }

    // ---- Authority requirements (audit) ----
    if (f.requireMintAuthorityDisabled) {
      const xOk =
        pool.tokenX.audit?.mintAuthorityDisabled === true ||
        pool.tokenX.risk?.mintAuthorityDisabled === true;
      const yOk =
        pool.tokenY.audit?.mintAuthorityDisabled === true ||
        pool.tokenY.risk?.mintAuthorityDisabled === true;
      report.mintAuthorityDisabled = {
        value: xOk && yOk,
        threshold: "both-disabled",
        passed: xOk && yOk,
      };
    }
    if (f.requireFreezeAuthorityDisabled) {
      const xOk =
        pool.tokenX.audit?.freezeAuthorityDisabled === true ||
        pool.tokenX.risk?.freezeAuthorityDisabled === true;
      const yOk =
        pool.tokenY.audit?.freezeAuthorityDisabled === true ||
        pool.tokenY.risk?.freezeAuthorityDisabled === true;
      report.freezeAuthorityDisabled = {
        value: xOk && yOk,
        threshold: "both-disabled",
        passed: xOk && yOk,
      };
    }

    return report;
  }

  /**
   * Resolve the real on-chain active bin (and current price) for pools that
   * passed hard filters, just before the LLM batch. The Pool Discovery API
   * does not return active bin, so without this every pool carries
   * `activeBinId = 0` â€" which the LLM misreads as a one-sided-liquidity
   * anomaly and downgrades to WATCH/SKIP. Best-effort: `enrichOnChain` never
   * throws and returns `{}` on failure, leaving the pool unchanged.
   */
  private async enrichActiveBins(
    results: ScreeningResult[],
    progress?: ProgressReporter,
  ): Promise<void> {
    const targets = results.filter((r) => r.filtersPassed);
    if (targets.length === 0) return;

    progress?.emit({
      phase: "onchain",
      percent: 49,
      message: `Resolving on-chain active bin for ${targets.length} filtered pools`,
      current: 0,
      total: targets.length,
    });

    const sem = new Semaphore(this.config.meteora.onchainConcurrency ?? DEFAULT_ONCHAIN_CONCURRENCY);
    let done = 0;
    await Promise.all(
      targets.map((r) =>
        sem.runExclusive(async () => {
          try {
            const onchain = await this.deps.meteora.enrichOnChain(
              r.pool.address,
            );
            if (typeof onchain.activeBinId === "number") {
              r.pool.activeBinId = onchain.activeBinId;
            }
            if (
              typeof onchain.currentPrice === "number" &&
              Number.isFinite(onchain.currentPrice) &&
              onchain.currentPrice > 0
            ) {
              r.pool.currentPrice = onchain.currentPrice;
            }
          } catch (err) {
            this.log.warn(
              {
                err: err instanceof Error ? err.message : String(err),
                pool: r.pool.address,
              },
              "on-chain active-bin enrichment failed",
            );
          } finally {
            done++;
          }
        }),
      ),
    );

    progress?.emit({
      phase: "onchain",
      percent: 51,
      message: `On-chain active bin resolved for ${done}/${targets.length} pools`,
      current: done,
      total: targets.length,
    });
  }

  private async runLlmBatch(
    results: ScreeningResult[],
    progress?: ProgressReporter,
  ): Promise<void> {
    let targets = results.filter((r) => r.filtersPassed);
    if (targets.length === 0) {
      progress?.emit({
        phase: "llm",
        status: "skipped",
        percent: 82,
        message: "No pools passed filters, skipping LLM calls",
      });
      return;
    }

    targets = targets
      .map((result, index) => ({
        result,
        index,
        score: preLlmCandidateScore(result, this.config.entryPolicy.scoringWeights),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((item) => item.result);

    // Cost + latency control: cap LLM calls per cycle after policy scoring.
    const policyCap = this.config.entryPolicy.enabled
      ? this.config.entryPolicy.maxLlmCandidates
      : undefined;
    const configuredCap = this.config.llm.maxCallsPerScreenCycle;
    const cap = minPositive(configuredCap, policyCap);
    if (cap && cap > 0 && targets.length > cap) {
      this.log.info(
        { passed: targets.length, cap },
        "capping llm calls per cycle",
      );
      targets = targets.slice(0, cap);
    }

    let completed = 0;
    const total = targets.length;
    progress?.emit({
      phase: "llm",
      percent: 52,
      message: `Running LLM decisions for ${total} filtered pools`,
      current: 0,
      total,
    });

    const sem = new Semaphore(this.config.llm.concurrency ?? DEFAULT_LLM_CONCURRENCY);
    await Promise.all(
      targets.map((r) =>
        sem.runExclusive(async () => {
          try {
            progress?.emit({
              phase: "llm",
              percent: 52 + (completed / Math.max(1, total)) * 30,
              message: `LLM evaluating ${r.pool.name}`,
              current: completed,
              total,
              poolAddress: r.pool.address,
              poolName: r.pool.name,
            });
            const started = Date.now();
            const { decision, raw, usage } = await this.callLlm(r);
            const latencyMs = Date.now() - started;
            if (decision) r.decision = decision;
            if (raw) r.llmRaw = raw;

            // Emit a per-call LLM run record for the web bridge.
            if (this.deps.llmRunsEmitter && decision) {
              try {
                this.deps.llmRunsEmitter.append({
                  ts: Date.now(),
                  cycleId: r.cycleId,
                  poolAddress: r.pool.address,
                  poolName: r.pool.name,
                  model: this.llm.model,
                  promptTokens: usage?.inputTokens ?? 0,
                  completionTokens: usage?.outputTokens ?? 0,
                  latencyMs,
                  costUsd: usage?.costUsd ?? 0,
                  decision,
                  reasoning: formatReasoning(decision, raw),
                  promptSummary: `Evaluated ${r.pool.name} against ${
                    Object.keys(r.filterReport).length
                  } hard filters and ${r.realtimeSignals.length} recent signals.`,
                });
              } catch (err) {
                this.log.warn(
                  { err, pool: r.pool.address },
                  "llm-runs emitter failed",
                );
              }
            }
          } catch (err) {
            this.log.warn({ err, pool: r.pool.address }, "llm call failed");
          } finally {
            completed++;
            progress?.emit({
              phase: "llm",
              percent: 52 + (completed / Math.max(1, total)) * 30,
              message: `LLM completed ${completed}/${total} pools`,
              current: completed,
              total,
              poolAddress: r.pool.address,
              poolName: r.pool.name,
            });
          }
        }),
      ),
    );
    progress?.emit({
      phase: "llm",
      percent: 84,
      message: `LLM batch complete for ${completed}/${total} pools`,
      current: completed,
      total,
    });
  }

  private async callLlm(result: ScreeningResult): Promise<{
    decision?: LLMDecision;
    raw?: string;
    usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  }> {
    const memory = this.deps.memoryRouter?.forScreener(result);
    const userPrompt = this.buildUserPrompt(result, memory);

    const resp = await this.llm.generate({
      systemPrompt: this.systemPrompt,
      userPrompt,
      temperature: this.config.llm.temperature,
      maxTokens: this.config.llm.maxTokens,
      timeoutMs: this.config.llm.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
      jsonMode: true,
    });

    if (!resp.ok) {
      this.log.warn(
        { err: resp.error, pool: result.pool.address, provider: resp.provider },
        "llm call failed",
      );
      return {};
    }

    if (!resp.raw) {
      this.log.warn(
        { pool: result.pool.address },
        "llm returned empty content",
      );
      return { usage: resp.usage };
    }

    // Debug: log raw response for validation
    this.log.debug(
      {
        pool: result.pool.address,
        responseLen: resp.raw.length,
        rawPreview: resp.raw.slice(0, 300),
      },
      "llm raw response received",
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(resp.raw);
    } catch (err) {
      this.log.warn(
        {
          err,
          pool: result.pool.address,
          rawHead: resp.raw.slice(0, 200),
          rawLen: resp.raw.length,
          isTruncated: resp.raw.length >= (resp.usage?.outputTokens ?? 0) * 4,
        },
        "llm content not valid JSON",
      );
      return { raw: resp.raw, usage: resp.usage };
    }

    const validated = DecisionSchema.safeParse(parsed);
    if (!validated.success) {
      this.log.warn(
        {
          issues: validated.error.issues,
          pool: result.pool.address,
          parsedKeys: Object.keys(parsed as object),
        },
        "llm decision failed schema validation",
      );
      return { raw: resp.raw, usage: resp.usage };
    }
    const decision =
      validated.data.action === "ENTER"
        ? {
            ...validated.data,
            suggestedRangeBps: clampSuggestedRangeBps(
              validated.data.suggestedRangeBps,
              result.pool.binStep,
            ),
          }
        : validated.data;

    // Debug: log parsed decision
    this.log.info(
      {
        pool: result.pool.address,
        action: decision.action,
        confidence: decision.confidence,
        reasonsCount: decision.reasons?.length ?? 0,
        risksCount: decision.risks?.length ?? 0,
        suggestedSizeUsd: decision.suggestedSizeUsd,
        suggestedRangeBps: decision.suggestedRangeBps,
      },
      "llm decision parsed",
    );

    if (
      validated.data.suggestedRangeBps !== undefined &&
      decision.suggestedRangeBps !== validated.data.suggestedRangeBps
    ) {
      this.log.warn(
        {
          pool: result.pool.address,
          binStep: result.pool.binStep,
          suggestedRangeBps: validated.data.suggestedRangeBps,
          guardedRangeBps: decision.suggestedRangeBps,
        },
        "llm suggested range exceeded bin guard; clamped",
      );
    }

    return { decision, raw: resp.raw, usage: resp.usage };
  }

  /**
   * For every result where the LLM said ENTER and hard filters passed, ask
   * the Manager to open a position. Best-effort â€" failures are logged and
   * do not abort the cycle. Honors `config.dryRun`.
   */
  private async autoOpenEnterDecisions(
    results: ScreeningResult[],
    cycleId: string,
  ): Promise<void> {
    const enters = results.filter(
      (r) => r.filtersPassed && r.decision?.action === "ENTER",
    );
    if (enters.length === 0) return;

    let selected = selectTopEnterCandidates(
      enters,
      this.config.entryPolicy.enabled
        ? this.config.entryPolicy.maxDeploysPerCycle
        : enters.length,
      this.config.entryPolicy.scoringWeights,
    );
    const selectedSet = new Set(selected.map((r) => r.pool.address));
    for (const r of enters) {
      if (!selectedSet.has(r.pool.address)) {
        const reason = "not_top_ranked";
        this.markDeployGate(r, "blocked", reason, "NO_DEPLOY");
        this.recordNoDeploy(r, reason, cycleId);
      }
    }
    if (selected.length === 0) return;

    const deployable: ScreeningResult[] = [];
    for (const r of selected) {
      const collapseGuard = evaluateCollapseGuard(r.pool, this.config);
      if (
        !collapseGuard.passed &&
        this.config.entryPolicy.collapseGuard.mode === "enforce"
      ) {
        const reason = this.collapseGuardReason(collapseGuard);
        this.markDeployGate(r, "blocked", reason, "NO_DEPLOY");
        this.recordNoDeploy(r, reason, cycleId);
        continue;
      }
      deployable.push(r);
    }
    selected = deployable;
    if (selected.length === 0) return;

    if (this.config.dryRun) {
      this.log.info(
        { cycleId, enterCount: enters.length, wouldOpenCount: selected.length },
        "dryRun: recording WOULD_OPEN candidates",
      );
      for (const r of selected) {
        const dec = r.decision;
        if (!dec) continue;
        const { sizeUsd, rangeBps } = this.openParamsForDecision(dec);
        this.markDeployGate(r, "would_open", "shadow_mode", "WOULD_OPEN");
        this.recordWouldOpen(r, sizeUsd, rangeBps, cycleId);
      }

      if (
        !this.config.paperTrading.enabled ||
        !this.config.paperTrading.openOnDryRun
      ) {
        return;
      }

      const manager = this.deps.manager;
      if (manager) {
        this.log.info(
          { cycleId, count: selected.length },
          "opening paper positions from dry-run ENTER decisions",
        );
        for (const r of selected) {
          const dec = r.decision;
          if (!dec) continue;
          const { sizeUsd, rangeBps } = this.openParamsForDecision(dec);
          const entrySnapshot = buildEntrySnapshot(r, dec.confidence);
          try {
            this.markDeployGate(
              r,
              "requested",
              "paper manager validation requested",
              "LLM_DECISION",
            );
            const opened = await manager.openPaper(
              {
                poolAddress: r.pool.address,
                sizeUsd,
                rangeBps,
                dryRun: true,
                paper: true,
                cycleIdOnEnter: cycleId,
                entrySnapshot,
                notes: `auto-enter cycleId=${cycleId} paper=true`,
              },
              { cycleId },
            );
            if (opened) {
              this.markDeployGate(
                r,
                "opened",
                "paper position opened",
                "OPEN_SUCCESS",
              );
              this.log.info(
                {
                  cycleId,
                  pool: r.pool.address,
                  positionPubkey: opened.positionPubkey,
                  sizeUsd,
                  rangeBps,
                },
                "paper position auto-opened",
              );
            } else {
              this.markDeployGate(
                r,
                "blocked",
                "paper manager refused open",
                "NO_DEPLOY",
              );
            }
          } catch (err) {
            this.markDeployGate(
              r,
              "failed",
              err instanceof Error ? err.message : String(err),
              "OPEN_FAILED",
            );
            this.log.warn(
              {
                err: err instanceof Error ? err.message : String(err),
                pool: r.pool.address,
                cycleId,
              },
              "paper auto-open failed",
            );
          }
        }
        return;
      }

      const commandEmitter = this.deps.commandEmitter;
      if (!commandEmitter) {
        for (const r of selected) {
          const reason = "paper manager unavailable";
          this.markDeployGate(r, "blocked", reason, "NO_DEPLOY");
          this.recordNoDeploy(r, reason, cycleId);
        }
        return;
      }

      this.log.info(
        { cycleId, count: selected.length },
        "queueing paper open commands from dry-run ENTER decisions",
      );
      for (const r of selected) {
        const dec = r.decision;
        if (!dec) continue;
        const { sizeUsd, rangeBps } = this.openParamsForDecision(dec);
        const entrySnapshot = buildEntrySnapshot(r, dec.confidence);
        const commandId = `paper-open-${cycleId}-${r.pool.address}`;
        const command: BotCommand = {
          ts: Date.now(),
          id: commandId,
          kind: "open",
          args: {
            poolAddress: r.pool.address,
            sizeUsd,
            rangeBps,
            dryRun: true,
            paper: true,
            cycleId,
            cycleIdOnEnter: cycleId,
            entrySnapshot,
            notes: `auto-enter cycleId=${cycleId} paper=true`,
          },
        };
        commandEmitter.appendSync(command);
        this.markDeployGate(
          r,
          "queued",
          "paper open command queued",
          "OPEN_QUEUED",
        );
        this.recordOpenQueued(r, commandId, sizeUsd, rangeBps, cycleId);
      }
      return;
    }

    const manager = this.deps.manager;
    if (!manager) {
      const commandEmitter = this.deps.commandEmitter;
      if (!commandEmitter) {
        for (const r of selected) {
          const reason = "manager unavailable";
          this.markDeployGate(r, "blocked", reason, "NO_DEPLOY");
          this.recordNoDeploy(r, reason, cycleId);
        }
        return;
      }

      this.log.info(
        { cycleId, count: selected.length },
        "queueing open commands from ENTER decisions",
      );
      for (const r of selected) {
        const dec = r.decision;
        if (!dec) continue;
        const { sizeUsd, rangeBps } = this.openParamsForDecision(dec);
        const entrySnapshot = buildEntrySnapshot(r, dec.confidence);
        const commandId = `auto-open-${cycleId}-${r.pool.address}`;
        const command: BotCommand = {
          ts: Date.now(),
          id: commandId,
          kind: "open",
          args: {
            poolAddress: r.pool.address,
            sizeUsd,
            rangeBps,
            dryRun: this.config.dryRun,
            cycleId,
            cycleIdOnEnter: cycleId,
            entrySnapshot,
            notes: `auto-enter cycleId=${cycleId}`,
          },
        };
        commandEmitter.appendSync(command);
        this.markDeployGate(r, "queued", "open command queued", "OPEN_QUEUED");
        this.recordOpenQueued(r, commandId, sizeUsd, rangeBps, cycleId);
        this.log.info(
          {
            cycleId,
            commandId,
            pool: r.pool.address,
            sizeUsd,
            rangeBps,
          },
          "open command queued for manager",
        );
      }
      return;
    }

    this.log.info(
      { cycleId, count: selected.length },
      "auto-opening positions from ENTER decisions",
    );

    const openSem = new Semaphore(2);
    await Promise.allSettled(
      selected.map((r) =>
        openSem.runExclusive(async () => {
          const dec = r.decision;
          if (!dec) return;
          const { sizeUsd, rangeBps } = this.openParamsForDecision(dec);
          const entrySnapshot = buildEntrySnapshot(r, dec.confidence);
          try {
            this.markDeployGate(
              r,
              "requested",
              "manager validation requested",
              "LLM_DECISION",
            );
            const opened = await manager.open(
              {
                poolAddress: r.pool.address,
                sizeUsd,
                rangeBps,
                dryRun: this.config.dryRun,
                cycleIdOnEnter: cycleId,
                entrySnapshot,
                notes: `auto-enter cycleId=${cycleId}`,
              },
              { cycleId },
            );
            if (opened) {
              this.markDeployGate(
                r,
                "opened",
                "position opened",
                "OPEN_SUCCESS",
              );
              this.log.info(
                {
                  cycleId,
                  pool: r.pool.address,
                  positionPubkey: opened.positionPubkey,
                  sizeUsd,
                  rangeBps,
                  dryRun: opened.dryRun,
                },
                "position auto-opened",
              );
            } else {
              this.markDeployGate(
                r,
                "blocked",
                "manager refused open",
                "NO_DEPLOY",
              );
            }
          } catch (err) {
            this.markDeployGate(
              r,
              "failed",
              err instanceof Error ? err.message : String(err),
              "OPEN_FAILED",
            );
            this.log.warn(
              {
                err: err instanceof Error ? err.message : String(err),
                pool: r.pool.address,
                cycleId,
              },
              "auto-open failed",
            );
          }
        }),
      ),
    );
  }

  private openParamsForDecision(decision: LLMDecision): {
    sizeUsd: number;
    rangeBps: number;
  } {
    const sizeOverride = this.config.manager.positionSizeUsd;
    const sizeUsd =
      sizeOverride && sizeOverride > 0
        ? sizeOverride
        : decision.suggestedSizeUsd && decision.suggestedSizeUsd > 0
          ? decision.suggestedSizeUsd
          : this.config.manager.fallbackSizeUsd ?? DEFAULT_FALLBACK_SIZE_USD;

    const rangeCap = this.config.manager.defaultRangeBps;
    const llmRange =
      decision.suggestedRangeBps && decision.suggestedRangeBps > 0
        ? decision.suggestedRangeBps
        : rangeCap && rangeCap > 0
          ? rangeCap
          : DEFAULT_FALLBACK_RANGE_BPS;
    const rangeBps =
      rangeCap && rangeCap > 0 ? Math.min(llmRange, rangeCap) : llmRange;

    return { sizeUsd, rangeBps };
  }

  private collapseGuardReason(result: {
    reasonCode?: string;
    risks: string[];
  }): string {
    const code = result.reasonCode ?? "collapse_guard_failed";
    const detail = result.risks[0] ?? "collapse guard failed";
    return `${code}: ${detail}`;
  }

  private markDeployGate(
    result: ScreeningResult,
    status: DeployGateAuditStatus,
    reason: string,
    sourceEvent: DeployGateAudit["sourceEvent"],
  ): void {
    result.deployGate = {
      status,
      reason,
      maxDeploysPerCycle: this.config.entryPolicy.enabled
        ? this.config.entryPolicy.maxDeploysPerCycle
        : undefined,
      timestamp: Date.now(),
      sourceEvent,
    };
  }

  private deployGateForDecision(result: ScreeningResult): DeployGateAudit {
    if (result.deployGate) return result.deployGate;
    if (result.decision?.action !== "ENTER") {
      return {
        status: "not_applicable",
        reason: "LLM did not request ENTER",
        timestamp: Date.now(),
        sourceEvent: "LLM_DECISION",
      };
    }
    return {
      status: "pending",
      reason: "executor deploy gate not reached yet",
      maxDeploysPerCycle: this.config.entryPolicy.enabled
        ? this.config.entryPolicy.maxDeploysPerCycle
        : undefined,
      timestamp: Date.now(),
      sourceEvent: "LLM_DECISION",
    };
  }

  private screenDecisionSummary(
    result: ScreeningResult,
    gate: DeployGateAudit,
  ): string {
    const decision = result.decision;
    if (!decision) return `No LLM decision for ${result.pool.name}`;
    const llmLabel = `LLM_${decision.action}`;
    const base = `${llmLabel} ${result.pool.name} at confidence ${decision.confidence.toFixed(2)}`;
    if (decision.action !== "ENTER") return base;
    const gateLabel =
      gate.status === "blocked"
        ? "deploy blocked"
        : gate.status === "would_open"
          ? "deploy gate passed; would open in dry-run"
          : gate.status === "queued"
            ? "deploy gate passed; open queued"
            : gate.status === "opened"
              ? "deploy gate passed; paper opened"
              : gate.status === "requested"
                ? "deploy gate passed; manager validating"
                : gate.status === "failed"
                  ? "deploy failed"
                  : "deploy gate pending";
    return `${base}; ${gateLabel}${gate.reason ? ` (${gate.reason})` : ""}`;
  }

  private recordScreenDecision(result: ScreeningResult, dryRun: boolean): void {
    const decision = result.decision;
    if (!decision) return;
    const deployGate = this.deployGateForDecision(result);
    this.deps.decisionJournal?.safeAppend({
      actor: "SCREENER",
      event: "SCREEN_DECISION",
      subject: subjectFromScreeningResult(result),
      action: `LLM_${decision.action}`,
      status: "PROPOSED",
      summary: this.screenDecisionSummary(result, deployGate),
      reasons: decision.reasons,
      risks: decision.risks,
      metrics: {
        ...screeningMetrics(result),
        llmAction: decision.action,
        llmConfidence: decision.confidence,
        deployGateStatus: deployGate.status,
        deployGateReason: deployGate.reason ?? null,
        deployGateMaxDeploysPerCycle: deployGate.maxDeploysPerCycle ?? null,
        deployGateSourceEvent: deployGate.sourceEvent ?? null,
        suggestedSizeUsd: decision.suggestedSizeUsd ?? null,
        suggestedRangeBps: decision.suggestedRangeBps ?? null,
      },
      rejectedAlternatives: ["ENTER", "WATCH", "SKIP"].filter(
        (action) => action !== decision.action,
      ),
      linkedIds: { cycleId: result.cycleId },
      dryRun,
      raw: result.llmRaw,
    });
  }

  private recordOpenQueued(
    result: ScreeningResult,
    commandId: string,
    sizeUsd: number,
    rangeBps: number,
    cycleId: string,
  ): void {
    const decision = result.decision;
    this.deps.decisionJournal?.safeAppend({
      actor: "EXECUTOR",
      event: "OPEN_QUEUED",
      subject: subjectFromScreeningResult(result),
      action: "OPEN",
      status: "INFO",
      summary: `Queued open for ${result.pool.name}`,
      reasons: [
        "manager command queued",
        ...(decision?.reasons ?? []).slice(0, 2),
      ],
      risks: decision?.risks ?? [],
      metrics: {
        ...screeningMetrics(result),
        llmConfidence: decision?.confidence ?? null,
        sizeUsd,
        rangeBps,
      },
      rejectedAlternatives: [],
      linkedIds: { cycleId, commandId, cycleIdOnEnter: cycleId },
      dryRun: this.config.dryRun,
      raw: result.llmRaw,
    });
  }

  private recordWouldOpen(
    result: ScreeningResult,
    sizeUsd: number,
    rangeBps: number,
    cycleId: string,
  ): void {
    const decision = result.decision;
    this.deps.decisionJournal?.safeAppend({
      actor: "EXECUTOR",
      event: "WOULD_OPEN",
      subject: subjectFromScreeningResult(result),
      action: "OPEN",
      status: "PROPOSED",
      summary: `Would open ${result.pool.name} in shadow mode`,
      reasons: [
        "shadow_mode",
        ...(result.entryPolicy?.reasons ?? []),
        ...(decision?.reasons ?? []).slice(0, 2),
      ],
      risks: decision?.risks ?? [],
      metrics: {
        ...screeningMetrics(result),
        llmConfidence: decision?.confidence ?? null,
        entryScore: scoreEnterCandidate(result, this.config.entryPolicy.scoringWeights),
        sizeUsd,
        rangeBps,
      },
      rejectedAlternatives: [],
      linkedIds: { cycleId, cycleIdOnEnter: cycleId },
      dryRun: true,
      raw: result.llmRaw,
    });
  }

  private recordNoDeploy(
    result: ScreeningResult,
    reason: string,
    cycleId: string,
  ): void {
    const decision = result.decision;
    this.deps.decisionJournal?.safeAppend({
      actor: "EXECUTOR",
      event: "NO_DEPLOY",
      subject: subjectFromScreeningResult(result),
      action: "OPEN",
      status: "SKIPPED",
      summary: `No deploy for ${result.pool.name}: ${reason}`,
      reasons: [reason, ...(decision?.reasons ?? []).slice(0, 2)],
      risks: decision?.risks ?? [],
      metrics: {
        ...screeningMetrics(result),
        llmConfidence: decision?.confidence ?? null,
      },
      rejectedAlternatives: ["OPEN_POSITION"],
      linkedIds: { cycleId },
      dryRun: this.config.dryRun,
      raw: result.llmRaw,
    });
  }

  private recordShadowDisagreement(
    result: ScreeningResult,
    decisionId: string,
    score: ShadowScore,
  ): void {
    const disagreement = score.disagreement;
    if (!disagreement) return;
    this.deps.decisionJournal?.safeAppend({
      actor: "LEARNING",
      event: "SHADOW_DISAGREEMENT",
      subject: subjectFromScreeningResult(result),
      action: disagreement.shadowRecommendation,
      status: "INFO",
      summary: `Shadow recommends ${disagreement.shadowRecommendation} while LLM chose ${disagreement.llmAction}`,
      reasons: score.topEvidence.slice(0, 3).map((e) => e.summary),
      risks:
        disagreement.shadowRecommendation === "avoid"
          ? [`expectedScore ${score.expectedScore.toFixed(3)}`]
          : [],
      metrics: {
        expectedScore: score.expectedScore,
        riskScore: score.riskScore,
        sampleSize: score.sampleSize,
        confidence: score.confidence,
        magnitude: disagreement.magnitude,
      },
      rejectedAlternatives: [String(disagreement.llmAction)],
      linkedIds: { cycleId: result.cycleId, learningDecisionId: decisionId },
      dryRun: this.config.dryRun,
    });
  }

  private buildUserPrompt(
    result: ScreeningResult,
    memory?: PromptMemoryBundle,
  ): string {
    const signalSummary: Record<string, number> = {};
    for (const s of result.realtimeSignals) {
      const key: RealtimeEventKind = s.kind;
      signalSummary[key] = (signalSummary[key] ?? 0) + 1;
    }
    const signalHints = this.config.learning.enabled
      ? readSignalWeightsPromptHints(this.config.learning.files.signalWeights)
      : undefined;

    const snapshot = {
      pool: {
        address: result.pool.address,
        name: result.pool.name,
        binStep: result.pool.binStep,
        baseFeeBps: result.pool.baseFeeBps,
        tvl: result.pool.tvl,
        activeTvl: result.pool.activeTvl,
        // Activity metrics are windowed to `timeframe` (default 5m), NOT 24h.
        timeframe: this.config.meteora.timeframe,
        volumeWindow: result.pool.volume24h,
        feesWindow: result.pool.fees24h,
        feeAprAnnualizedPct: result.pool.feeApr24h,
        feeAprActiveAnnualizedPct: result.pool.feeAprActive24h,
        activeBinId: result.pool.activeBinId,
        currentPrice: result.pool.currentPrice,
        createdAt: result.pool.createdAt,
      },
      tokenX: redactTokenInfo(result.pool.tokenX),
      tokenY: redactTokenInfo(result.pool.tokenY),
      filterReport: result.filterReport,
      entryPolicy:
        this.config.entryPolicy.enabled &&
        this.config.entryPolicy.mode === "observe"
          ? { ...result.entryPolicy, passed: true }
          : result.entryPolicy,
      rangeGuidance: rangeGuidanceForBinStep(result.pool.binStep),
      realtimeSignals: {
        countsByKind: signalSummary,
        last5: result.realtimeSignals.slice(-5),
      },
      ...(signalHints ? { signalHints } : {}),
      ...(hasPromptMemory(memory) ? { memory } : {}),
    };

    return [
      "Pool snapshot follows. Decide ENTER / WATCH / SKIP per system spec.",
      "If you use memory, cite journalId or lessonId inside reasons/risks/notes.",
      "Respond ONLY with the JSON object specified by the system prompt.",
      "",
      JSON.stringify(snapshot, null, 2),
    ].join("\n");
  }

  // ---------- watchdog accessors ----------

  /** Timestamp (ms) of the last completed cycle, or null. */
  getLastCycleAt(): number | null {
    return this.lastCycleAt;
  }

  /** Current cron expression (e.g. "*\/30 * * * *"). */
  getCronExpression(): string {
    return this.config.scheduler.screenCron;
  }

  /** Whether the cron task is currently registered. */
  isCronRunning(): boolean {
    return this.cronTask !== null;
  }

  private emitCandidatesSnapshot(
    cycleId: string,
    results: ScreeningResult[],
    stage: "pre_llm" | "final",
  ): void {
    if (!this.deps.candidatesEmitter) return;
    try {
      this.deps.candidatesEmitter.append({
        ts: Date.now(),
        cycleId,
        stage,
        candidates: results.map((r) => toDashboardPoolCandidate(r)),
      });
      this.log.info(
        {
          cycleId,
          stage,
          count: results.length,
          path: this.deps.candidatesEmitter.path(),
        },
        "candidates snapshot emitted",
      );
    } catch (err) {
      this.log.warn({ err, cycleId, stage }, "candidates emitter failed");
    }
  }
}

// ---------- helpers ----------

function mergeTokenInfo(base: TokenInfo, extra: Partial<TokenInfo>): TokenInfo {
  return {
    mint: base.mint,
    symbol: extra.symbol ?? base.symbol,
    name: extra.name ?? base.name,
    decimals:
      typeof extra.decimals === "number" ? extra.decimals : base.decimals,
    marketCap: extra.marketCap ?? base.marketCap,
    fdv: extra.fdv ?? base.fdv,
    holders: extra.holders ?? base.holders,
    organicScore: extra.organicScore ?? base.organicScore,
    priceUsd: extra.priceUsd ?? base.priceUsd,
    audit: extra.audit ?? base.audit,
    launchpad: extra.launchpad ?? base.launchpad,
    priceStats: extra.priceStats ?? base.priceStats,
    smartMoney: extra.smartMoney ?? base.smartMoney,
    risk: extra.risk ?? base.risk,
  };
}

function numericGate(
  value: number | undefined,
  threshold: number,
  mode: "min" | "max",
): FilterReportEntry {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return { value, threshold, passed: false };
  }
  const passed = mode === "min" ? value >= threshold : value <= threshold;
  return { value, threshold, passed };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function rangeGate(
  value: number | undefined,
  min: number,
  max: number,
): FilterReportEntry {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return { value, threshold: `${min}..${max}`, passed: false };
  }
  return {
    value,
    threshold: `${min}..${max}`,
    passed: value >= min && value <= max,
  };
}

function minPositive(...values: Array<number | undefined>): number | undefined {
  const positives = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return positives.length > 0 ? Math.min(...positives) : undefined;
}

function preLlmCandidateScore(result: ScreeningResult, weights?: { feeRatio?: number; volumeRatio?: number; swaps?: number; liquidityAdds?: number; liquidityRemoves?: number }): number {
  const w = { feeRatio: 100, volumeRatio: 20, swaps: 5, liquidityAdds: 3, liquidityRemoves: 8, ...weights };
  const activeTvl = Math.max(result.pool.activeTvl, 1);
  const tvl = Math.max(result.pool.tvl, 1);
  const feeRatioPct = (result.pool.fees24h / activeTvl) * 100;
  const volumeRatioPct = (result.pool.volume24h / tvl) * 100;
  const realtime = result.entryPolicy?.realtime;
  return (
    feeRatioPct * w.feeRatio +
    volumeRatioPct * w.volumeRatio +
    (realtime?.swaps ?? 0) * w.swaps +
    (realtime?.liquidityAdds ?? 0) * w.liquidityAdds -
    (realtime?.liquidityRemoves ?? 0) * w.liquidityRemoves
  );
}

function subjectFromScreeningResult(result: ScreeningResult): {
  poolAddress: string;
  poolName: string;
  tokenSymbols: string[];
} {
  return {
    poolAddress: result.pool.address,
    poolName: result.pool.name,
    tokenSymbols: [result.pool.tokenX.symbol, result.pool.tokenY.symbol],
  };
}

function screeningMetrics(
  result: ScreeningResult,
): Record<string, string | number | boolean | null> {
  const activeTvl = Math.max(result.pool.activeTvl ?? 0, 1);
  const metrics: Record<string, string | number | boolean | null> = {
    filtersPassed: result.filtersPassed,
    tvl: result.pool.tvl,
    activeTvl: result.pool.activeTvl,
    volumeWindow: result.pool.volume24h,
    feesWindow: result.pool.fees24h,
    volume24h: result.pool.volume24h,
    fees24h: result.pool.fees24h,
    feeActiveTvlRatioPct: (result.pool.fees24h / activeTvl) * 100,
    feeActiveTvlRatio: result.pool.fees24h / activeTvl,
    binStep: result.pool.binStep,
    baseFeeBps: result.pool.baseFeeBps,
    entryPolicyPassed: result.entryPolicy?.passed ?? null,
    realtimeSwaps: result.entryPolicy?.realtime.swaps ?? null,
    realtimeDistinctSlots: result.entryPolicy?.realtime.distinctSlots ?? null,
    realtimeLiquidityAdds: result.entryPolicy?.realtime.liquidityAdds ?? null,
    realtimeLiquidityRemoves:
      result.entryPolicy?.realtime.liquidityRemoves ?? null,
    realtimeLatestSignalAgeMs:
      result.entryPolicy?.realtime.latestSignalAgeMs ?? null,
  };
  for (const [key, entry] of Object.entries(result.filterReport)) {
    metrics[`filter.${key}.passed`] = entry.passed;
    if (
      entry.value === undefined ||
      typeof entry.value === "number" ||
      typeof entry.value === "string" ||
      typeof entry.value === "boolean"
    ) {
      metrics[`filter.${key}.value`] = entry.value ?? null;
    }
  }
  return metrics;
}

/**
 * Build a human-readable reasoning string for the web UI from the LLM
 * decision. We try to keep the raw model text when it isn't pure JSON, then
 * fall back to "reasons + risks" bullets so the UI always has paragraphs.
 */
function formatReasoning(
  decision: LLMDecision,
  raw: string | undefined,
): string {
  if (raw) {
    const trimmed = raw.trim();
    // If the raw output is pure JSON we cannot show it as prose â€" fall through
    // to the reasons/risks composition below.
    const looksJson = trimmed.startsWith("{") && trimmed.endsWith("}");
    if (!looksJson) {
      return trimmed;
    }
  }
  const paragraphs: string[] = [];
  if (decision.reasons.length > 0) {
    paragraphs.push(decision.reasons.join("\n"));
  }
  if (decision.risks.length > 0) {
    paragraphs.push(`Risks:\n- ${decision.risks.join("\n- ")}`);
  }
  if (decision.notes) {
    paragraphs.push(decision.notes);
  }
  return paragraphs.join("\n\n");
}

function shouldEmitProgress(completed: number, total: number): boolean {
  if (total <= 0) return false;
  if (completed === 1 || completed === total) return true;
  if (total <= 10) return true;
  const step = Math.max(1, Math.ceil(total / 10));
  return completed % step === 0;
}

function shallowTopLevelDiff(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (!deepEqualScreener(a[k], b[k])) out.push(k);
  }
  return out;
}

function deepEqualScreener(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualScreener(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqualScreener(ao[k], bo[k])) return false;
  }
  return true;
}

function hasOkxData(t: TokenInfo): boolean {
  return t.risk?.available === true || t.smartMoney?.available === true;
}

function tokenOkxCriticalFlags(t: TokenInfo): string[] {
  const risk = t.risk;
  if (!risk) return [];
  const flags = new Set((risk.flags ?? []).map((flag) => flag.toLowerCase()));
  const out: string[] = [];
  if (risk.isHoneypot || flags.has("honeypot")) {
    out.push(`${t.symbol}:honeypot`);
  }
  if (risk.isWash || flags.has("wash")) {
    out.push(`${t.symbol}:wash`);
  }
  return out;
}

function redactTokenInfo(t: TokenInfo): Record<string, unknown> {
  return {
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    marketCap: t.marketCap,
    fdv: t.fdv,
    holders: t.holders,
    organicScore: t.organicScore,
    priceUsd: t.priceUsd,
    audit: t.audit,
    launchpad: t.launchpad,
    priceStats: t.priceStats,
    okxStatus: hasOkxData(t) ? "available" : "unavailable",
    smartMoney: t.smartMoney,
    risk: t.risk,
  };
}
