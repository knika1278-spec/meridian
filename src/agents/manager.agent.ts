import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import cron, { type ScheduledTask } from "node-cron";
import { Semaphore } from "async-mutex";
import { z } from "zod";

import type {
  UserConfig,
  Position,
  Pool,
  PositionToken,
  PositionLastEvaluation,
  PositionEvaluation,
  ClosedPosition,
  Lesson,
  ManagerCycleReport,
  ManagerAction,
  ManagerCycleActionRecord,
  OpenPositionInput,
  PromptMemoryBundle,
  DlmmStrategy,
  RealtimeEvent,
} from "../types/index.js";
import { childLogger, type Logger } from "../utils/logger.js";
import type { JsonlEmitter } from "../utils/jsonl-emitter.js";
import type { MeteoraTools } from "../tools/meteora.tools.js";
import type { JupiterTools } from "../tools/jupiter.tools.js";
import type {
  CloseResult,
  MeteoraActions,
} from "../tools/meteora-actions.tools.js";
import type { JupiterSwapClient } from "../tools/jupiter-swap.tools.js";
import type { WalletTools } from "../tools/wallet.tools.js";
import type { LlmProvider } from "../llm/types.js";
import type { PositionTracker } from "./position-tracker.js";
import type { ClosedPositionStore } from "./closed-position-store.js";
import type { LessonStore } from "./lesson-store.js";
import type { PositionEvaluator } from "./position-evaluator.js";
import type { RealtimeListener } from "./realtime.listener.js";
import type { LearningRecorder } from "../learning/recorder.js";
import type { OutcomeCollector } from "../learning/outcome-collector.js";
import type { LessonMiner } from "../learning/lesson-miner.js";
import type { LearningSnapshotEmitter } from "../learning/snapshot-emitter.js";
import type { SignalWeightsEmitter } from "../learning/signal-weights.js";
import type { DecisionJournal } from "../memory/decision-journal.js";
import type { MemoryRouter } from "../memory/memory-router.js";
import { hasPromptMemory } from "../memory/memory-router.js";
import { ProgressReporter, type ProgressSink } from "../utils/progress.js";
import type { BlacklistStore } from "./blacklist-store.js";
import type { PoolMemoryStore } from "./pool-memory-store.js";
import type { TradeLedger } from "./trade-ledger.js";
import type { TradingCircuitBreaker } from "./circuit-breaker.js";
import { evaluateSafety } from "./safety-gate.js";
import type { SafetySnapshot, SafetyDecision } from "./safety-gate.js";
import { evaluateStrategyAutomation } from "./strategy-automator.js";
import {
  recentForFromSnapshotFile,
  validateFreshEntry,
} from "../utils/entry-policy.js";
import { normalizeIlLossUsd } from "../utils/pnl.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MANAGER_PROMPT_PATH = path.resolve(
  __dirname,
  "../../prompts/manager.system.md",
);
const POST_MORTEM_PROMPT_PATH = path.resolve(
  __dirname,
  "../../prompts/post-mortem.system.md",
);

const DEFAULT_LLM_TIMEOUT_MS = 180_000;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9;
const DEFAULT_ENTRY_REALTIME_EVENT_LIMIT = 20;
const COMMAND_EVENT_MAX_FUTURE_MS = 5_000;
const REALTIME_EVENT_KINDS = new Set<string>([
  "new_pool",
  "liquidity_add",
  "liquidity_remove",
  "swap",
  "volume_spike",
  "active_bin_change",
  "unknown",
]);

type FreshRealtimeSource = "listener" | "command_snapshot" | "snapshot_file";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTE_MINTS = new Set<string>([SOL_MINT, USDC_MINT]);
const DEFAULT_MAX_BINS_PER_SIDE = 30;

const ManagerDecisionSchema = z.object({
  action: z.enum(["HOLD", "CLAIM", "CLOSE", "REBALANCE"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  risks: z.array(z.string()),
  rebalance: z
    .object({
      // LLM sends 0 on non-rebalance actions (HOLD/CLAIM/CLOSE).  Allow 0 so
      // the whole decision object parses; business logic gates on action===REBALANCE.
      newRangeBps: z.number().int().min(0),
    })
    .optional(),
  notes: z.string().optional(),
});

const PostMortemDuplicateSchema = z.object({
  duplicateOf: z.string().min(1),
});

const PostMortemNewLessonSchema = z.object({
  tags: z.array(z.string()),
  positiveTakeaway: z.string().nullable().optional(),
  mistake: z.string().nullable().optional(),
  ruleForFuture: z.string().min(1),
  context: z
    .object({
      entry: z.string().optional(),
      exit: z.string().optional(),
      pnlUsd: z.number().optional(),
    })
    .optional(),
});

const PostMortemSchema = z.union([
  PostMortemDuplicateSchema,
  PostMortemNewLessonSchema,
]);

export interface ManagerDeps {
  meteora: MeteoraTools;
  jupiter: JupiterTools;
  jupiterSwap?: JupiterSwapClient;
  actions: MeteoraActions;
  wallet: WalletTools;
  llm: LlmProvider;
  tracker: PositionTracker;
  closedStore: ClosedPositionStore;
  lessonStore: LessonStore;
  evaluator: PositionEvaluator;
  listener?: RealtimeListener;
  progressEmitter?: JsonlEmitter;
  onProgress?: ProgressSink;
  /**
   * Optional learning recorder. When provided, each finalized manager
   * decision is logged as a LearningDecision (skips/errors filtered by
   * the recorder itself). Failures here never break the manager cycle.
   */
  learningRecorder?: LearningRecorder;
  /** Optional outcome collector — labels due decisions once per cycle. */
  outcomeCollector?: OutcomeCollector;
  /** Optional lesson miner — derives candidate lessons once per cycle. */
  lessonMiner?: LessonMiner;
  /** Optional snapshot emitter — writes a learning snapshot row per cycle. */
  snapshotEmitter?: LearningSnapshotEmitter;
  /** Optional signal observation emitter; never mutates config or thresholds. */
  signalWeightsEmitter?: SignalWeightsEmitter;
  /** Optional append-only decision journal. Failures never block manager cycles. */
  decisionJournal?: DecisionJournal;
  /** Optional prompt memory router backed by journal + lessons + learning evidence. */
  memoryRouter?: MemoryRouter;
  /** Optional blacklist store — used to skip blacklisted tokens during open(). */
  blacklistStore?: BlacklistStore;
  /** Optional pool-memory store — records closed pools for cooldown enforcement. */
  poolMemoryStore?: PoolMemoryStore;
  /**
   * Optional live-trading ledger (data/trade-log.jsonl). Required for the
   * Phase 4 safety gate to permit live opens — when safety is enabled but this
   * is absent, live opens are refused (fail-closed). Records only real trades.
   */
  tradeLedger?: TradeLedger;
  /**
   * Optional trading circuit breaker. Halts live opens after N consecutive
   * losing closes; persists across restarts. Required (with tradeLedger) for
   * the safety gate to permit live opens.
   */
  circuitBreaker?: TradingCircuitBreaker;
}

interface HeuristicDecision {
  kind: "hold" | "claim" | "close";
  reason: string;
  /** True when this is a hard rule that must override an opposing LLM decision. */
  critical: boolean;
}

type OpenSizingResolution =
  | {
      ok: true;
      input: OpenPositionInput;
      source: "input" | "usd-override" | "sol-config";
      solContext?: {
        balanceSol: number;
        deployableSol: number;
        deploySol: number;
        solPriceUsd: number;
      };
    }
  | { ok: false; reason: string };

export interface ManagerRunOptions {
  commandId?: string;
}

export interface CloseTrackedPositionResult {
  success: boolean;
  closed?: ClosedPosition;
  signature?: string;
  dryRun: boolean;
  error?: string;
}

export class ManagerAgent {
  private config: UserConfig;
  private readonly deps: ManagerDeps;
  private readonly log: Logger;
  private readonly managerSystemPrompt: string;
  private readonly postMortemSystemPrompt: string;

  private cronTask: ScheduledTask | null = null;
  private riskWatcherTimer: NodeJS.Timeout | null = null;
  private running = false;
  private riskWatcherRunning = false;
  private lastCycleAt: number | null = null;

  // Real-time rebalance trigger: throttle per-pool evaluations
  private readonly realtimeThrottle = new Map<string, number>();
  private static readonly REALTIME_THROTTLE_MS = 10_000;

  // Cooldown after rebalance to prevent risk watcher from closing before TX confirms
  private readonly rebalanceCooldown = new Map<string, number>();
  private static readonly REBALANCE_COOLDOWN_MS = 30_000;

  constructor(config: UserConfig, deps: ManagerDeps) {
    this.config = config;
    this.deps = deps;
    this.log = childLogger("manager");
    this.managerSystemPrompt = this.loadPrompt(
      MANAGER_PROMPT_PATH,
      "manager system prompt",
    );
    this.postMortemSystemPrompt = this.loadPrompt(
      POST_MORTEM_PROMPT_PATH,
      "post-mortem system prompt",
    );
  }

  /**
   * Close a position from the canonical tracker and mirror the normal manager
   * bookkeeping: journal the decision, execute the DLMM close flow, archive the
   * closed outcome, and remove the open position once the close is real.
   */
  async closeTrackedPosition(
    positionPubkey: string,
    reason = "manual close",
    opts: ManagerRunOptions = {},
  ): Promise<CloseTrackedPositionResult> {
    const position = this.deps.tracker.get(positionPubkey);
    if (!position) {
      return {
        success: false,
        dryRun: this.config.dryRun,
        error: `position not tracked: ${positionPubkey}`,
      };
    }

    const cycleId =
      opts.commandId ??
      `manual-close-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    let evaluation: PositionEvaluation | null = null;
    try {
      const freshEvaluation = await this.deps.evaluator.evaluate(position);
      if (freshEvaluation) {
        evaluation = freshEvaluation;
        this.deps.tracker.update(position.positionPubkey, {
          lastEvaluation: toPositionLastEvaluation(freshEvaluation),
        });
      }
    } catch (err) {
      this.log.warn(
        { err, positionPubkey: position.positionPubkey },
        "manual close evaluation failed; using persisted entry snapshot",
      );
    }
    evaluation ??= fallbackEvaluationFromPosition(position);

    const action: ManagerAction = {
      kind: "close",
      reason,
      confidence: 1,
    };

    if (this.deps.learningRecorder) {
      try {
        this.deps.learningRecorder.recordManager({
          position,
          evaluation,
          action,
          cycleTimestamp: Date.now(),
        });
      } catch (err) {
        this.log.warn(
          { err, positionPubkey: position.positionPubkey },
          "learning recorder failed",
        );
      }
    }

    this.recordManagerDecision(position, evaluation, action, cycleId);
    const exec = await this.execute(position, evaluation, action);
    this.recordManagerActionResult(
      position,
      evaluation,
      action,
      exec.success,
      cycleId,
      exec.error,
    );

    const effectiveDryRun = this.config.dryRun || position.dryRun;
    if (!exec.success) {
      return {
        success: false,
        dryRun: effectiveDryRun,
        error: exec.error ?? "close failed",
      };
    }

    const closed = exec.closed;
    if (this.shouldMutatePositionState(position)) {
      if (closed) this.deps.closedStore.add(closed);
      this.deps.tracker.remove(position.positionPubkey);
      if (closed) {
        await this.generateLesson(closed).catch((err) => {
          this.log.warn(
            { err, positionPubkey: position.positionPubkey },
            "post-close lesson generation failed",
          );
        });
      }
    } else {
      this.log.info(
        { positionPubkey: position.positionPubkey },
        "manual close simulated; tracker left unchanged",
      );
    }

    return {
      success: true,
      ...(closed ? { closed } : {}),
      ...(closed?.closeTxSignature
        ? { signature: closed.closeTxSignature }
        : {}),
      dryRun: effectiveDryRun,
    };
  }

  // ------------------------------------------------------------------
  // public api
  // ------------------------------------------------------------------

  startAuto(): void {
    if (this.cronTask) {
      this.log.warn("startAuto called but cron already running");
      return;
    }
    const expr = this.config.manager.cron;
    if (!cron.validate(expr)) {
      this.log.error({ expr }, "invalid cron expression; manager not started");
      return;
    }
    this.cronTask = cron.schedule(expr, () => {
      if (this.running) {
        this.log.warn(
          "previous manager cycle still running; skipping this tick",
        );
        return;
      }
      this.running = true;
      this.runOnce()
        .catch((err) => this.log.error({ err }, "manager cron cycle error"))
        .finally(() => {
          this.lastCycleAt = Date.now();
          this.running = false;
        });
    });
    this.log.info({ expr }, "manager auto mode started");
    this.startRiskWatcher();
  }

  stopAuto(): void {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
      this.log.info("manager auto mode stopped");
    }
    this.stopRiskWatcher();
  }

  private startRiskWatcher(): void {
    if (this.config.manager.riskWatcherEnabled === false) return;
    if (this.riskWatcherTimer) return;
    const intervalSec = this.config.manager.riskWatcherIntervalSec ?? 30;
    this.riskWatcherTimer = setInterval(() => {
      void this.runRiskWatcher().catch((err) => {
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "risk watcher tick failed",
        );
      });
    }, intervalSec * 1000);
    this.riskWatcherTimer.unref?.();
    this.log.info({ intervalSec }, "deterministic risk watcher started");
  }

  private stopRiskWatcher(): void {
    if (!this.riskWatcherTimer) return;
    clearInterval(this.riskWatcherTimer);
    this.riskWatcherTimer = null;
    this.log.info("deterministic risk watcher stopped");
  }

  private async runRiskWatcher(): Promise<void> {
    if (this.running || this.riskWatcherRunning) return;
    const open = this.deps.tracker.listOpen();
    if (open.length === 0) return;

    this.riskWatcherRunning = true;
    const cycleId = `risk-watch-${Date.now().toString(36)}`;
    try {
      for (const position of open) {
        const evaluation = await this.deps.evaluator.evaluate(position);
        if (!evaluation) continue;
        this.deps.tracker.update(position.positionPubkey, {
          lastEvaluation: toPositionLastEvaluation(evaluation),
        });
        const heuristic = this.deriveHeuristic(position, evaluation);
        if (!heuristic.critical || heuristic.kind !== "close") continue;

        // Skip if position was recently rebalanced (cooldown)
        const rebalanceAt = this.rebalanceCooldown.get(position.positionPubkey);
        if (rebalanceAt && Date.now() - rebalanceAt < ManagerAgent.REBALANCE_COOLDOWN_MS) {
          this.log.debug(
            { position: position.positionPubkey, cooldownMs: ManagerAgent.REBALANCE_COOLDOWN_MS },
            "risk watcher: skipping close — rebalance cooldown active",
          );
          continue;
        }

        const action: ManagerAction = {
          kind: "close",
          reason: `risk-watcher: ${heuristic.reason}`,
          confidence: 1,
        };
        this.recordManagerDecision(position, evaluation, action, cycleId);
        const exec = await this.execute(position, evaluation, action);
        this.recordManagerActionResult(
          position,
          evaluation,
          action,
          exec.success,
          cycleId,
          exec.error,
        );
        if (!exec.success) continue;
        if (!this.shouldMutatePositionState(position)) {
          this.log.info(
            { positionPubkey: position.positionPubkey, action: action.kind },
            "risk watcher action simulated for live position; tracker left unchanged",
          );
          continue;
        }
        if (exec.closed) this.deps.closedStore.add(exec.closed);
        this.deps.tracker.remove(position.positionPubkey);
        if (exec.closed) {
          await this.generateLesson(exec.closed).catch((err) => {
            this.log.warn(
              { err, positionPubkey: position.positionPubkey },
              "risk watcher lesson generation failed",
            );
          });
        }
      }
    } finally {
      this.riskWatcherRunning = false;
    }
  }

  /**
   * Handle a realtime event (swap/active_bin_change) for potential immediate
   * rebalance. When the active bin moves outside a position's range, triggers
   * rebalance without waiting for the next cron cycle.
   *
   * Throttled to one evaluation per pool per REALTIME_THROTTLE_MS to avoid
   * overwhelming the RPC with rapid-fire evaluations.
   */
  async handleRealtimeEvent(event: RealtimeEvent): Promise<void> {
    const rtConfig = this.config.manager.realtimeRebalance;
    if (!rtConfig?.enabled) return;
    if (!event.poolAddress) return;
    if (event.kind === "swap" && rtConfig.triggerOnSwap === false) return;
    if (
      event.kind === "active_bin_change" &&
      rtConfig.triggerOnBinChange === false
    )
      return;
    if (event.kind !== "swap" && event.kind !== "active_bin_change") return;

    const open = this.deps.tracker.listOpen();
    const position = open.find((p) => p.poolAddress === event.poolAddress);
    if (!position) return;

    // Throttle: skip if evaluated recently for this pool
    const now = Date.now();
    const throttleMs = rtConfig.throttleMs ?? ManagerAgent.REALTIME_THROTTLE_MS;
    const lastEval = this.realtimeThrottle.get(event.poolAddress) ?? 0;
    if (now - lastEval < throttleMs) return;
    this.realtimeThrottle.set(event.poolAddress, now);

    try {
      const evaluation = await this.deps.evaluator.evaluate(position);
      if (!evaluation) return;

      // Update tracker with fresh evaluation
      this.deps.tracker.update(position.positionPubkey, {
        lastEvaluation: toPositionLastEvaluation(evaluation),
      });

      // Check if position is out of range
      if (evaluation.inRange) return;

      this.log.info(
        {
          pool: position.poolName,
          positionPubkey: position.positionPubkey,
          activeBin: evaluation.currentActiveBinId,
          lowerBin: position.lowerBinId,
          upperBin: position.upperBinId,
          inRangePct: evaluation.inRangePct,
          outOfRangeMinutes: evaluation.outOfRangeMinutes,
        },
        "realtime trigger: position out of range, evaluating rebalance",
      );

      // Derive heuristic — if critical close is triggered, handle it
      const heuristic = this.deriveHeuristic(position, evaluation);
      if (heuristic.critical && heuristic.kind === "close") {
        const cycleId = `realtime-${now.toString(36)}`;
        const action: ManagerAction = {
          kind: "close",
          reason: `realtime-trigger: ${heuristic.reason}`,
          confidence: 1,
        };
        this.recordManagerDecision(
          position,
          evaluation,
          action,
          cycleId,
        );
        const exec = await this.execute(position, evaluation, action);
        this.recordManagerActionResult(
          position,
          evaluation,
          action,
          exec.success,
          cycleId,
          exec.error,
        );
        if (exec.success && this.shouldMutatePositionState(position)) {
          if (exec.closed) this.deps.closedStore.add(exec.closed);
          this.deps.tracker.remove(position.positionPubkey);
          if (exec.closed) {
            await this.generateLesson(exec.closed).catch((err) => {
              this.log.warn(
                { err, positionPubkey: position.positionPubkey },
                "realtime trigger lesson generation failed",
              );
            });
          }
        }
        return;
      }

      // Non-critical out-of-range: trigger rebalance to new active bin
      const cycleId = `realtime-${now.toString(36)}`;
      const action: ManagerAction = {
        kind: "rebalance",
        reason: `realtime-trigger: active bin ${evaluation.currentActiveBinId} outside range [${position.lowerBinId}, ${position.upperBinId}]`,
        confidence: 1,
        newRangeBps: this.config.manager.defaultRangeBps ?? 600,
      };
      this.recordManagerDecision(position, evaluation, action, cycleId);
      const exec = await this.execute(position, evaluation, action);
      this.recordManagerActionResult(
        position,
        evaluation,
        action,
        exec.success,
        cycleId,
        exec.error,
      );
      if (exec.success && this.shouldMutatePositionState(position)) {
        // Set cooldown to prevent risk watcher from closing before TX confirms
        this.rebalanceCooldown.set(position.positionPubkey, Date.now());
        this.deps.tracker.remove(position.positionPubkey);
        if (exec.newPosition) this.deps.tracker.add(exec.newPosition);
        this.log.info(
          {
            pool: position.poolName,
            oldRange: `[${position.lowerBinId}, ${position.upperBinId}]`,
            newPosition: exec.newPosition?.positionPubkey,
          },
          "realtime trigger: rebalance executed",
        );
      }
    } catch (err) {
      this.log.debug(
        {
          pool: position.poolName,
          err: err instanceof Error ? err.message : String(err),
        },
        "realtime trigger evaluation failed",
      );
    }
  }

  /**
   * Apply a hot-reloaded config snapshot. Re-schedules the manager cron if
   * the `manager.cron` expression changed and warns when fields that
   * require a full process restart were modified (RPC, API keys, LLM
   * provider, etc.).
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
    if (prev.meteoraPnl.baseUrl !== next.meteoraPnl.baseUrl) {
      restartRequired.push("meteoraPnl.baseUrl");
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
    if (this.cronTask && prev.manager.cron !== next.manager.cron) {
      this.log.info(
        { prev: prev.manager.cron, next: next.manager.cron },
        "cron rescheduled",
      );
      this.stopAuto();
      this.startAuto();
    } else if (
      this.cronTask &&
      (prev.manager.riskWatcherEnabled !== next.manager.riskWatcherEnabled ||
        prev.manager.riskWatcherIntervalSec !==
          next.manager.riskWatcherIntervalSec)
    ) {
      this.stopRiskWatcher();
      this.startRiskWatcher();
    }

    this.log.info({ changedKeys }, "manager config hot-reloaded");
  }

  async runOnce(opts: ManagerRunOptions = {}): Promise<ManagerCycleReport> {
    const cycleId = `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const timestamp = Date.now();
    const open = this.deps.tracker.listOpen();
    const progress = new ProgressReporter({
      source: "MANAGER",
      cycleId,
      emitter: this.deps.progressEmitter,
      sink: this.deps.onProgress,
      commandId: opts.commandId,
    });
    progress.emit({
      phase: "cycle",
      percent: 0,
      message: `Starting manager cycle for ${open.length} open position(s)`,
      current: 0,
      total: open.length,
    });
    this.log.info(
      { cycleId, openCount: open.length },
      "manager cycle starting",
    );

    // Log wallet balance as source of truth every cycle
    if (this.deps.wallet.isConfigured()) {
      try {
        const balanceSol = await this.deps.wallet.getBalanceSol();
        const prices = await this.deps.jupiter.getPriceUsd([SOL_MINT]);
        const solPriceUsd = prices[SOL_MINT] ?? 0;
        const balanceUsd = balanceSol * solPriceUsd;
        this.log.info(
          {
            balanceSol: balanceSol.toFixed(4),
            balanceUsd: balanceUsd.toFixed(2),
            solPriceUsd: solPriceUsd.toFixed(2),
          },
          "wallet balance check",
        );
        // Emit to progress for dashboard
        progress.emit({
          phase: "wallet",
          percent: 0,
          message: `Wallet: ${balanceSol.toFixed(4)} SOL ($${balanceUsd.toFixed(2)})`,
        });
        // Record in decision journal for historical tracking
        this.deps.decisionJournal?.safeAppend({
          actor: "MANAGER",
          event: "WALLET_BALANCE",
          subject: { poolAddress: "", tokenSymbols: [] },
          action: "BALANCE_CHECK",
          status: "INFO",
          summary: `Wallet balance: ${balanceSol.toFixed(4)} SOL ($${balanceUsd.toFixed(2)})`,
          reasons: [],
          risks: [],
          metrics: {
            balanceSol,
            balanceUsd,
            solPriceUsd,
            openPositions: this.deps.tracker.count(),
            maxOpenPositions: this.config.manager.maxOpenPositions,
          },
          rejectedAlternatives: [],
          linkedIds: { cycleId },
          dryRun: this.config.dryRun,
        });
      } catch (err) {
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "wallet balance check failed",
        );
      }
    }

    const evaluations: PositionEvaluation[] = [];
    const actions: ManagerCycleActionRecord[] = [];
    let closedCount = 0;
    let claimedCount = 0;
    let rebalancedCount = 0;
    let lessonsLearned = 0;

    // ─── Phase 1: parallel evaluations (read-only RPC/REST calls) ────────
    type EvalEntry = {
      position: (typeof open)[number];
      index: number;
      evaluation: PositionEvaluation | null;
    };

    const evalEntries: EvalEntry[] = await Promise.all(
      open.map(async (position, index) => {
        progress.emit({
          phase: "evaluate",
          percent: managerLoopPercent(index, open.length),
          message: `Evaluating ${position.poolName}`,
          current: index,
          total: open.length,
          poolAddress: position.poolAddress,
          poolName: position.poolName,
          positionPubkey: position.positionPubkey,
        });
        let evaluation: PositionEvaluation | null = null;
        try {
          evaluation = await this.deps.evaluator.evaluate(position);
        } catch (err) {
          this.log.warn(
            { err, positionPubkey: position.positionPubkey },
            "position evaluation threw",
          );
        }
        return { position, index, evaluation };
      }),
    );

    // ─── Phase 2: parallel LLM decisions (network calls, no on-chain writes) ─
    type ActionEntry = EvalEntry & { finalAction: ManagerAction | null };
    const llmSem = new Semaphore(2);

    const actionEntries: ActionEntry[] = await Promise.all(
      evalEntries.map(async ({ position, index, evaluation }) => {
        if (!evaluation) {
          return { position, index, evaluation, finalAction: null };
        }

        evaluations.push(evaluation);
        this.deps.tracker.update(position.positionPubkey, {
          lastEvaluation: toPositionLastEvaluation(evaluation),
        });

        const heuristic = this.deriveHeuristic(position, evaluation);
        let finalAction: ManagerAction = {
          kind: heuristic.kind,
          reason: heuristic.reason,
        };

        if (this.config.manager.useLlm) {
          progress.emit({
            phase: "llm",
            percent: Math.min(85, managerLoopPercent(index, open.length) + 8),
            message: `Asking LLM for ${position.poolName}`,
            current: index,
            total: open.length,
            poolAddress: position.poolAddress,
            poolName: position.poolName,
            positionPubkey: position.positionPubkey,
          });
          const llmAction = await llmSem.runExclusive(() =>
            this.callManagerLlm(position, evaluation),
          );
          if (llmAction) {
            finalAction = this.reconcile(heuristic, llmAction);
          }
        }

        if (this.deps.learningRecorder) {
          try {
            this.deps.learningRecorder.recordManager({
              position,
              evaluation,
              action: finalAction,
              cycleTimestamp: timestamp,
            });
          } catch (err) {
            this.log.warn(
              { err, positionPubkey: position.positionPubkey },
              "learning recorder failed",
            );
          }
        }

        this.recordManagerDecision(position, evaluation, finalAction, cycleId);
        return { position, index, evaluation, finalAction };
      }),
    );

    // ─── Phase 3: serial execute (on-chain writes must stay sequential) ──
    for (const { position, index, evaluation, finalAction } of actionEntries) {
      if (!evaluation) {
        const reconciled = await this.reconcileMissingOnChainPosition(
          position,
          cycleId,
        );
        if (reconciled) {
          actions.push({
            positionPubkey: position.positionPubkey,
            action: {
              kind: "close",
              reason: reconciled.exitReason,
              confidence: 1,
            },
            success: true,
          });
          closedCount++;
          progress.emit({
            phase: "evaluate",
            status: "success",
            percent: managerLoopPercent(index + 1, open.length),
            message: `Reconciled externally closed ${position.poolName}`,
            current: index + 1,
            total: open.length,
            poolAddress: position.poolAddress,
            poolName: position.poolName,
            positionPubkey: position.positionPubkey,
          });
        } else {
          actions.push({
            positionPubkey: position.positionPubkey,
            action: { kind: "skip", reason: "evaluation unavailable" },
            success: false,
          });
          progress.emit({
            phase: "evaluate",
            status: "failed",
            percent: managerLoopPercent(index + 1, open.length),
            message: `Evaluation unavailable for ${position.poolName}`,
            current: index + 1,
            total: open.length,
            poolAddress: position.poolAddress,
            poolName: position.poolName,
            positionPubkey: position.positionPubkey,
          });
        }
        continue;
      }

      if (!finalAction) continue;

      progress.emit({
        phase: "action",
        percent: Math.min(90, managerLoopPercent(index, open.length) + 14),
        message: `${finalAction.kind.toUpperCase()} selected for ${position.poolName}`,
        current: index,
        total: open.length,
        poolAddress: position.poolAddress,
        poolName: position.poolName,
        positionPubkey: position.positionPubkey,
      });
      const exec = await this.execute(position, evaluation, finalAction);
      this.recordManagerActionResult(
        position,
        evaluation,
        finalAction,
        exec.success,
        cycleId,
        exec.error,
      );
      actions.push({
        positionPubkey: position.positionPubkey,
        action: finalAction,
        success: exec.success,
        error: exec.error,
      });
      progress.emit({
        phase: "action",
        status: exec.success ? "running" : "failed",
        percent: managerLoopPercent(index + 1, open.length),
        message: `${finalAction.kind.toUpperCase()} ${exec.success ? "complete" : "failed"} for ${position.poolName}`,
        detail: exec.error,
        current: index + 1,
        total: open.length,
        poolAddress: position.poolAddress,
        poolName: position.poolName,
        positionPubkey: position.positionPubkey,
      });

      if (!exec.success) continue;

      switch (finalAction.kind) {
        case "claim":
          if (this.shouldMutatePositionState(position)) {
            claimedCount++;
          } else {
            this.log.info(
              { positionPubkey: position.positionPubkey },
              "claim simulated for live position; tracker left unchanged",
            );
          }
          break;
        case "close": {
          if (!this.shouldMutatePositionState(position)) {
            this.log.info(
              { positionPubkey: position.positionPubkey },
              "close simulated for live position; tracker left unchanged",
            );
            break;
          }
          closedCount++;
          const closed = exec.closed;
          if (closed) {
            this.deps.closedStore.add(closed);
          }
          this.deps.tracker.remove(position.positionPubkey);
          if (closed) {
            const lesson = await this.generateLesson(closed);
            if (lesson) lessonsLearned++;
          }
          break;
        }
        case "rebalance": {
          if (!this.shouldMutatePositionState(position)) {
            this.log.info(
              { positionPubkey: position.positionPubkey },
              "rebalance simulated for live position; tracker left unchanged",
            );
            break;
          }
          rebalancedCount++;
          // Update range in tracker instead of remove+add (position stays same)
          if (exec.newPosition) {
            this.deps.tracker.update(position.positionPubkey, {
              lowerBinId: exec.newPosition.lowerBinId,
              upperBinId: exec.newPosition.upperBinId,
              entryActiveBinId: exec.newPosition.entryActiveBinId,
              entryPrice: exec.newPosition.entryPrice,
              entryTimestamp: exec.newPosition.entryTimestamp,
            });
          }
          break;
        }
        default:
          break;
      }
    }

    const report: ManagerCycleReport = {
      cycleId,
      timestamp,
      evaluations,
      actions,
      closedCount,
      claimedCount,
      rebalancedCount,
      lessonsLearned,
    };
    this.log.info(
      {
        cycleId,
        closedCount,
        claimedCount,
        rebalancedCount,
        lessonsLearned,
        positions: open.length,
      },
      "manager cycle complete",
    );

    if (this.deps.outcomeCollector) {
      try {
        progress.emit({
          phase: "learning",
          percent: 95,
          message: "Collecting due learning outcomes",
        });
        await this.deps.outcomeCollector.runDue();
      } catch (err) {
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err), cycleId },
          "outcome collector failed",
        );
      }
    }
    if (this.deps.lessonMiner) {
      try {
        progress.emit({
          phase: "learning",
          percent: 97,
          message: "Mining lessons from outcomes",
        });
        const mined = await this.deps.lessonMiner.mine();
        if (mined.added > 0) {
          this.recordLessonMined(
            `Lesson miner added ${mined.added} lesson(s), deduped ${mined.deduped}`,
            { added: mined.added, deduped: mined.deduped },
            cycleId,
          );
        }
      } catch (err) {
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err), cycleId },
          "lesson miner failed",
        );
      }
    }
    if (this.deps.signalWeightsEmitter) {
      try {
        progress.emit({
          phase: "learning",
          percent: 98,
          message: "Writing signal weight observations",
        });
        this.deps.signalWeightsEmitter?.emit();
      } catch (err) {
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err), cycleId },
          "signal weights emitter failed",
        );
      }
    }
    if (this.deps.snapshotEmitter) {
      try {
        progress.emit({
          phase: "learning",
          percent: 99,
          message: "Writing learning snapshot",
        });
        this.deps.snapshotEmitter.emit();
      } catch (err) {
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err), cycleId },
          "snapshot emitter failed",
        );
      }
    }

    progress.emit({
      phase: "complete",
      status: "success",
      percent: 100,
      message: `Manager complete: ${actions.length} action(s), ${closedCount} closed, ${claimedCount} claimed`,
      current: open.length,
      total: open.length,
    });
    return report;
  }

  /** Open a new position. Called by ScreenerAgent on ENTER (future) or manually. */
  async open(
    input: OpenPositionInput,
    screeningContext?: { cycleId: string },
  ): Promise<Position | null> {
    const max = this.config.manager.maxOpenPositions;
    if (this.deps.tracker.count() >= max) {
      this.log.warn(
        { current: this.deps.tracker.count(), max },
        "max open positions reached; refusing to open",
      );
      this.recordOpenNoDeploy(
        input,
        "max open positions reached",
        screeningContext,
      );
      return null;
    }
    const isLiveOpen = !(input.dryRun ?? this.config.dryRun);
    // Early circuit-breaker check: bail before sizing / RPC work when halted.
    if (
      isLiveOpen &&
      this.config.safety.enabled &&
      this.deps.circuitBreaker &&
      !this.deps.circuitBreaker.canTrade()
    ) {
      const reason = `circuit breaker halted: ${
        this.deps.circuitBreaker.status().haltReason ?? "unknown"
      }`;
      this.log.error({ pool: input.poolAddress }, reason);
      this.recordOpenNoDeploy(input, reason, screeningContext);
      return null;
    }
    let effectiveInput = input;
    try {
      const freshValidation = await this.validateOpenFreshness(input);
      if (!freshValidation.ok) {
        this.log.warn(
          { pool: input.poolAddress, reason: freshValidation.reason },
          "open skipped by fresh entry validation",
        );
        this.recordOpenNoDeploy(
          input,
          freshValidation.reason,
          screeningContext,
        );
        return null;
      }

      const sizing = await this.resolveOpenSizing(input);
      if (!sizing.ok) {
        this.log.warn(
          { pool: input.poolAddress, reason: sizing.reason },
          "open skipped by position sizing guard",
        );
        this.recordOpenNoDeploy(input, sizing.reason, screeningContext);
        return null;
      }
      effectiveInput = sizing.input;
      if (sizing.source === "sol-config" && sizing.solContext) {
        this.log.info(
          {
            pool: effectiveInput.poolAddress,
            sizeUsd: effectiveInput.sizeUsd,
            ...sizing.solContext,
          },
          "open size resolved from SOL management config",
        );
      }
      // Collapse-guard REDUCE_SIZE: scale the resolved size down before the
      // safety gate so the per-trade USD cap sees the reduced figure.
      const sizeMultiplier = freshValidation.sizeMultiplier;
      if (
        sizeMultiplier < 1 &&
        typeof effectiveInput.sizeUsd === "number" &&
        effectiveInput.sizeUsd > 0
      ) {
        const reducedUsd = effectiveInput.sizeUsd * sizeMultiplier;
        this.log.warn(
          {
            pool: effectiveInput.poolAddress,
            sizeMultiplier,
            originalSizeUsd: effectiveInput.sizeUsd,
            reducedSizeUsd: reducedUsd,
          },
          "collapse guard reduce_size applied to open size",
        );
        effectiveInput = { ...effectiveInput, sizeUsd: reducedUsd };
      }
      // Phase 4 safety gate: final hard block on live capital deployment.
      // Runs after sizing so the per-trade USD cap sees the resolved size.
      if (isLiveOpen && this.config.safety.enabled) {
        const gate = this.evaluateOpenSafety(effectiveInput.sizeUsd);
        if (!gate.ok) {
          this.log.warn(
            {
              pool: effectiveInput.poolAddress,
              sizeUsd: effectiveInput.sizeUsd,
              code: gate.code,
              reason: gate.reason,
            },
            "open blocked by safety gate",
          );
          this.recordOpenNoDeploy(
            effectiveInput,
            gate.reason ?? "blocked by safety gate",
            screeningContext,
          );
          return null;
        }
      }
      const result = await this.deps.actions.openPosition({
        ...effectiveInput,
        dryRun: effectiveInput.dryRun ?? this.config.dryRun,
        cycleIdOnEnter:
          effectiveInput.cycleIdOnEnter ?? screeningContext?.cycleId,
        ...(typeof this.config.manager.priorityFeeLamports === "number"
          ? { priorityFeeLamports: this.config.manager.priorityFeeLamports }
          : {}),
      });
      const enriched: Position = {
        ...result.position,
        cycleIdOnEnter:
          result.position.cycleIdOnEnter ??
          effectiveInput.cycleIdOnEnter ??
          screeningContext?.cycleId,
        ...(effectiveInput.entrySnapshot
          ? { entrySnapshot: effectiveInput.entrySnapshot }
          : {}),
      };
      this.deps.tracker.add(enriched);
      const success = result.liquidityAdded && enriched.entryValueUsd > 0;
      this.log[success ? "info" : "warn"](
        {
          positionPubkey: enriched.positionPubkey,
          pool: enriched.poolName,
          dryRun: enriched.dryRun,
          signature: result.signature,
          entryValueUsd: enriched.entryValueUsd,
          error: result.error,
        },
        success
          ? "position opened"
          : "position initialization succeeded but liquidity was not added",
      );
      this.recordOpenResult(
        effectiveInput,
        enriched,
        success,
        screeningContext,
        result.error,
      );
      if (isLiveOpen && success && this.deps.tradeLedger) {
        this.deps.tradeLedger.recordOpen({
          poolAddress: enriched.poolAddress,
          poolName: enriched.poolName,
          sizeUsd:
            enriched.entryValueUsd > 0
              ? enriched.entryValueUsd
              : effectiveInput.sizeUsd,
          positionPubkey: enriched.positionPubkey,
        });
      }
      return success ? enriched : null;
    } catch (err) {
      this.log.error({ err, input: effectiveInput }, "failed to open position");
      this.recordOpenResult(
        effectiveInput,
        null,
        false,
        screeningContext,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  /**
   * Evaluate the Phase 4 safety limits for a candidate live open. Fail-closed:
   * if safety is enabled but the ledger/breaker are not wired, the open is
   * refused rather than allowed unchecked.
   */
  private evaluateOpenSafety(tradeSizeUsd: number): SafetyDecision {
    const { tradeLedger, circuitBreaker } = this.deps;
    if (!tradeLedger || !circuitBreaker) {
      return {
        ok: false,
        reason:
          "safety enabled but trade ledger / circuit breaker not wired — refusing live open (fail-closed)",
      };
    }
    const cfg = this.config.safety;
    const snapshot: SafetySnapshot = {
      tradeSizeUsd,
      dailySpendUsd: tradeLedger.getDailySpendUsd(),
      dailyTradeCount: tradeLedger.getDailyTradeCount(),
      dailyRealizedPnlUsd: tradeLedger.getDailyRealizedPnlUsd(),
      drawdownPct: tradeLedger.getDrawdownPct(cfg.startingCapitalUsd),
      circuitHalted: !circuitBreaker.canTrade(),
      circuitHaltReason: circuitBreaker.status().haltReason,
    };
    return evaluateSafety(cfg, snapshot);
  }

  // ------------------------------------------------------------------
  // internals — decisions
  // ------------------------------------------------------------------

  /**
   * Create a virtual dry-run position after the same fresh-entry and sizing
   * guards as a real open, without invoking MeteoraActions/openPosition.
   */
  async openPaper(
    input: OpenPositionInput,
    screeningContext?: { cycleId: string },
  ): Promise<Position | null> {
    const paperConfig = this.config.paperTrading;
    const paperInput: OpenPositionInput = {
      ...input,
      dryRun: true,
      paper: true,
      cycleIdOnEnter: input.cycleIdOnEnter ?? screeningContext?.cycleId,
    };

    if (!paperConfig.enabled) {
      this.recordOpenNoDeploy(
        paperInput,
        "paper trading disabled",
        screeningContext,
      );
      return null;
    }
    if (paperConfig.openMode !== "fresh_snapshot") {
      this.recordOpenNoDeploy(
        paperInput,
        `unsupported paper open mode: ${paperConfig.openMode}`,
        screeningContext,
      );
      return null;
    }

    const max =
      paperConfig.maxOpenPositions ?? this.config.manager.maxOpenPositions;
    const paperOpen = this.deps.tracker
      .listOpen()
      .filter((position) => position.dryRun).length;
    if (paperOpen >= max) {
      this.recordOpenNoDeploy(
        paperInput,
        "max paper open positions reached",
        screeningContext,
      );
      return null;
    }

    const duplicatePaper = this.deps.tracker
      .listOpen()
      .some(
        (position) =>
          position.dryRun && position.poolAddress === paperInput.poolAddress,
      );
    if (duplicatePaper) {
      this.recordOpenNoDeploy(
        paperInput,
        "paper position already open for pool",
        screeningContext,
      );
      return null;
    }

    let effectiveInput = paperInput;
    try {
      const freshValidation = await this.validateOpenFreshness(effectiveInput);
      if (!freshValidation.ok) {
        this.log.warn(
          { pool: effectiveInput.poolAddress, reason: freshValidation.reason },
          "paper open skipped by fresh entry validation",
        );
        this.recordOpenNoDeploy(
          effectiveInput,
          freshValidation.reason,
          screeningContext,
        );
        return null;
      }

      const sizing = await this.resolveOpenSizing(effectiveInput);
      if (!sizing.ok) {
        this.log.warn(
          { pool: effectiveInput.poolAddress, reason: sizing.reason },
          "paper open skipped by position sizing guard",
        );
        this.recordOpenNoDeploy(
          effectiveInput,
          sizing.reason,
          screeningContext,
        );
        return null;
      }
      effectiveInput = { ...sizing.input, dryRun: true, paper: true };

      const position = await this.buildPaperPosition(
        effectiveInput,
        screeningContext,
      );
      this.deps.tracker.add(position);
      this.log.info(
        {
          positionPubkey: position.positionPubkey,
          pool: position.poolName,
          entryValueUsd: position.entryValueUsd,
        },
        "paper position opened",
      );
      this.recordOpenResult(effectiveInput, position, true, screeningContext);
      return position;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { err, input: effectiveInput },
        "paper open skipped after validation",
      );
      this.recordOpenNoDeploy(effectiveInput, reason, screeningContext);
      return null;
    }
  }

  private shouldMutatePositionState(position: Position): boolean {
    return position.dryRun || !this.config.dryRun;
  }

  private shouldRecordOperationalPoolMemory(position: Position): boolean {
    return !position.dryRun && !this.config.dryRun;
  }

  private async swapClosedTokensToSol(
    position: Position,
    closeResult: CloseResult,
  ): Promise<void> {
    const cfg = this.config.manager.postCloseSwap;
    if (!cfg?.enabled) return;

    if (position.dryRun || this.config.dryRun || closeResult.dryRun) {
      this.log.info(
        { positionPubkey: position.positionPubkey },
        "post-close swap skipped in dry-run mode",
      );
      return;
    }

    if (!this.deps.jupiterSwap) {
      this.log.warn(
        { positionPubkey: position.positionPubkey },
        "post-close swap enabled but Jupiter swap client is not configured",
      );
      return;
    }

    if (!this.deps.wallet.isConfigured()) {
      this.log.warn(
        { positionPubkey: position.positionPubkey },
        "post-close swap skipped because wallet is not configured",
      );
      return;
    }

    let userPubkey: ReturnType<WalletTools["getPublicKey"]>;
    try {
      userPubkey = this.deps.wallet.getPublicKey();
    } catch (err) {
      this.log.warn(
        {
          positionPubkey: position.positionPubkey,
          err: err instanceof Error ? err.message : String(err),
        },
        "post-close swap skipped because wallet public key is unavailable",
      );
      return;
    }

    const proceeds = [
      {
        token: position.tokenX,
        amountRaw: addRawAmounts(
          closeResult.receivedX,
          closeResult.claimedFeeX,
        ),
      },
      {
        token: position.tokenY,
        amountRaw: addRawAmounts(
          closeResult.receivedY,
          closeResult.claimedFeeY,
        ),
      },
    ];

    let solPriceUsd: number | null | undefined;
    for (const item of proceeds) {
      const { token, amountRaw } = item;
      if (token.mint === SOL_MINT) continue;
      if (amountRaw <= 0n) continue;

      try {
        const quote = await this.deps.jupiterSwap.getQuote({
          inputMint: token.mint,
          outputMint: SOL_MINT,
          amount: amountRaw.toString(),
          slippageBps: cfg.slippageBps,
        });

        if (!quote) {
          this.log.warn(
            {
              positionPubkey: position.positionPubkey,
              mint: token.mint,
              amountRaw: amountRaw.toString(),
            },
            "post-close swap skipped because Jupiter quote is unavailable",
          );
          continue;
        }

        const priceImpactPct = toPercentPoints(quote.priceImpactPct);
        if (priceImpactPct > cfg.maxPriceImpactPct) {
          this.log.warn(
            {
              positionPubkey: position.positionPubkey,
              mint: token.mint,
              priceImpactPct,
              maxPriceImpactPct: cfg.maxPriceImpactPct,
            },
            "post-close swap skipped because price impact is too high",
          );
          continue;
        }

        let estimatedOutUsd: number | undefined;
        if (cfg.minSwapUsd > 0) {
          if (solPriceUsd === undefined) {
            solPriceUsd = await this.fetchSolPriceUsd();
          }
          if (!solPriceUsd || solPriceUsd <= 0) {
            this.log.warn(
              {
                positionPubkey: position.positionPubkey,
                mint: token.mint,
                minSwapUsd: cfg.minSwapUsd,
              },
              "post-close swap skipped because SOL price is unavailable",
            );
            continue;
          }

          const outSol = rawToUiNumber(quote.outAmount, SOL_DECIMALS);
          estimatedOutUsd = outSol * solPriceUsd;
          if (estimatedOutUsd < cfg.minSwapUsd) {
            this.log.info(
              {
                positionPubkey: position.positionPubkey,
                mint: token.mint,
                estimatedOutUsd,
                minSwapUsd: cfg.minSwapUsd,
              },
              "post-close swap skipped because quoted output is below minimum",
            );
            continue;
          }
        }

        const tx = await this.deps.jupiterSwap.buildSwapTransaction({
          quote,
          userPubkey,
          ...(typeof cfg.priorityFeeLamports === "number"
            ? { priorityFeeLamports: cfg.priorityFeeLamports }
            : {}),
        });

        if (!tx) {
          this.log.warn(
            {
              positionPubkey: position.positionPubkey,
              mint: token.mint,
              amountRaw: amountRaw.toString(),
            },
            "post-close swap skipped because Jupiter transaction build failed",
          );
          continue;
        }

        const result = await this.deps.wallet.signAndSend(tx, {
          dryRun: false,
          skipPreflight: false,
        });

        if (result.simulationError) {
          this.log.warn(
            {
              positionPubkey: position.positionPubkey,
              mint: token.mint,
              signature: result.signature,
              simulationError: result.simulationError,
            },
            "post-close swap simulation failed",
          );
          continue;
        }

        this.log.info(
          {
            positionPubkey: position.positionPubkey,
            inputMint: token.mint,
            inputSymbol: token.symbol,
            inputAmount: rawToUiNumber(amountRaw.toString(), token.decimals),
            outputMint: SOL_MINT,
            outputAmount: rawToUiNumber(quote.outAmount, SOL_DECIMALS),
            estimatedOutUsd,
            priceImpactPct,
            signature: result.signature,
          },
          "post-close swap executed",
        );
      } catch (err) {
        this.log.warn(
          {
            positionPubkey: position.positionPubkey,
            mint: token.mint,
            amountRaw: amountRaw.toString(),
            err: err instanceof Error ? err.message : String(err),
          },
          "post-close swap failed; leaving token proceeds in wallet",
        );
      }
    }
  }

  private async fetchSolPriceUsd(): Promise<number | null> {
    try {
      const prices = await this.deps.jupiter.getPriceUsd([SOL_MINT]);
      const price = prices[SOL_MINT];
      return typeof price === "number" && Number.isFinite(price) ? price : null;
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "post-close swap SOL price lookup failed",
      );
      return null;
    }
  }

  private async fetchFreshPool(poolAddress: string): Promise<Pool | null> {
    const fresh = await this.deps.meteora.fetchPairByAddress(poolAddress);
    if (!fresh) return null;
    const onChain = await this.deps.meteora.enrichOnChain(poolAddress);
    return { ...fresh, ...onChain };
  }

  private async buildPaperPosition(
    input: OpenPositionInput,
    screeningContext?: { cycleId: string },
  ): Promise<Position> {
    if (input.sizeUsd <= 0) {
      throw new Error("paper_open: sizeUsd must be > 0");
    }
    if (input.rangeBps <= 0) {
      throw new Error("paper_open: rangeBps must be > 0");
    }

    const pool = await this.fetchFreshPool(input.poolAddress);
    if (!pool) {
      throw new Error("fresh_filter_failed: pool unavailable");
    }
    if (!pool.binStep || pool.binStep <= 0) {
      throw new Error("fresh_filter_failed: invalid binStep");
    }

    const strategy: DlmmStrategy = input.strategy ?? "Spot";
    const activeBinId = pool.activeBinId;
    const requestedBinsPerSide = Math.max(
      1,
      Math.round(input.rangeBps / 2 / pool.binStep),
    );
    const maxBinsPerSide =
      this.config.manager.maxBinsPerSide ?? DEFAULT_MAX_BINS_PER_SIDE;
    const binsPerSide = Math.min(requestedBinsPerSide, maxBinsPerSide);
    const depositSide = resolvePaperDepositSide(pool);

    let lowerBinId: number;
    let upperBinId: number;
    if (depositSide === "Y") {
      lowerBinId = activeBinId - binsPerSide;
      upperBinId = activeBinId + 2;
    } else {
      lowerBinId = activeBinId;
      upperBinId = activeBinId + binsPerSide;
    }

    if (activeBinId >= upperBinId - 1) {
      throw new Error(
        `paper_open: bin-buffer guard triggered: activeBinId ${activeBinId} >= upperBinId-1 ${
          upperBinId - 1
        }`,
      );
    }

    const { amountX, amountY } = paperDepositAmounts(pool, depositSide, input);
    if (isZeroRaw(amountX) && isZeroRaw(amountY)) {
      throw new Error("paper_open: price unavailable for deposit token");
    }

    const now = Date.now();
    const notes = [
      input.notes,
      "paper=true",
      "openMode=fresh_snapshot",
      `depositSide=${depositSide}`,
      binsPerSide < requestedBinsPerSide
        ? `binsPerSide=${binsPerSide}/${requestedBinsPerSide}`
        : undefined,
    ]
      .filter((note): note is string => Boolean(note))
      .join(" | ");
    const lastEvaluation: PositionLastEvaluation = {
      evaluatedAt: now,
      currentActiveBinId: activeBinId,
      inRange: true,
      inRangePct: 1,
      outOfRangeMinutes: 0,
      currentPrice: pool.currentPrice,
      currentAmountX: amountX,
      currentAmountY: amountY,
      currentValueUsd: input.sizeUsd,
      claimableFees: { tokenX: "0", tokenY: "0", usdValue: 0 },
      pnlUsd: 0,
      pnlPct: 0,
      ilUsd: 0,
      ageMinutes: 0,
    };

    return {
      positionPubkey: paperPositionId(),
      poolAddress: input.poolAddress,
      poolName: pool.name,
      tokenX: tokenToPaperPositionToken(pool.tokenX),
      tokenY: tokenToPaperPositionToken(pool.tokenY),
      binStep: pool.binStep,
      lowerBinId,
      upperBinId,
      entryActiveBinId: activeBinId,
      entryPrice: pool.currentPrice,
      entryTimestamp: now,
      entryAmountX: amountX,
      entryAmountY: amountY,
      entryValueUsd: input.sizeUsd,
      strategyType: strategy,
      cycleIdOnEnter: input.cycleIdOnEnter ?? screeningContext?.cycleId,
      ...(input.entrySnapshot ? { entrySnapshot: input.entrySnapshot } : {}),
      dryRun: true,
      notes,
      sim: {
        currentValueUsd: input.sizeUsd,
        accruedFeesUsd: 0,
        activeBinId,
        inRange: true,
        lastUpdated: now,
      },
      lastEvaluation,
    };
  }

  private async validateOpenFreshness(
    input: OpenPositionInput,
  ): Promise<
    { ok: true; sizeMultiplier: number } | { ok: false; reason: string }
  > {
    const policy = this.config.entryPolicy;
    if (!policy.enabled) return { ok: true, sizeMultiplier: 1 };

    if (!input.entrySnapshot) {
      const autoIntent =
        Boolean(input.cycleIdOnEnter) || /auto-enter/i.test(input.notes ?? "");
      if (autoIntent && policy.mode === "enforce") {
        return {
          ok: false,
          reason: "stale_snapshot: missing entry snapshot",
        };
      }
      return { ok: true, sizeMultiplier: 1 };
    }

    const freshPool = await this.fetchFreshPool(input.poolAddress);
    if (!freshPool) {
      return { ok: false, reason: "fresh_filter_failed: pool unavailable" };
    }
    const freshRealtime = this.recentRealtimeForOpen(
      input,
      this.config.entryPolicy.realtime?.eventLimit ?? DEFAULT_ENTRY_REALTIME_EVENT_LIMIT,
    );
    const validation = validateFreshEntry({
      snapshot: input.entrySnapshot,
      freshPool,
      freshEvents: freshRealtime.events,
      freshRealtimeSource: freshRealtime.source,
      config: this.config,
    });

    if (validation.passed) {
      const micro = await this.validateMicroStability(
        input.poolAddress,
        freshPool,
      );
      if (!micro.ok) {
        if (policy.collapseGuard.mode === "observe") {
          this.log.warn(
            {
              pool: input.poolAddress,
              reason: micro.reason,
              metrics: micro.metrics,
            },
            "micro-stability validation failed in observe mode",
          );
        } else {
          this.log.warn(
            {
              pool: input.poolAddress,
              reason: micro.reason,
              metrics: micro.metrics,
            },
            "micro-stability validation failed",
          );
          return { ok: false, reason: micro.reason };
        }
      }
      if (validation.sizeMultiplier < 1) {
        this.log.warn(
          {
            pool: input.poolAddress,
            sizeMultiplier: validation.sizeMultiplier,
            metrics: validation.metrics,
          },
          "collapse guard reduce_size: opening at reduced size",
        );
      }
      this.log.info(
        {
          pool: input.poolAddress,
          freshRealtimeSource: freshRealtime.source,
          freshRealtimeEvents: freshRealtime.events.length,
          metrics: validation.metrics,
        },
        "fresh entry validation passed",
      );
      return { ok: true, sizeMultiplier: validation.sizeMultiplier };
    }
    const reason = `${validation.reasonCode ?? "fresh_filter_failed"}: ${
      validation.risks[0] ?? "fresh validation failed"
    }`;
    if (policy.mode === "observe") {
      this.log.warn(
        {
          pool: input.poolAddress,
          reason,
          freshRealtimeSource: freshRealtime.source,
          metrics: validation.metrics,
        },
        "fresh entry validation failed in observe mode",
      );
      return { ok: true, sizeMultiplier: 1 };
    }
    this.log.warn(
      {
        pool: input.poolAddress,
        reason,
        freshRealtimeSource: freshRealtime.source,
        metrics: validation.metrics,
      },
      "fresh entry validation failed",
    );
    return { ok: false, reason };
  }

  private async validateMicroStability(
    poolAddress: string,
    firstPool: Pool,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        reason: string;
        metrics: Record<string, number | string | boolean | null>;
      }
  > {
    const guard = this.config.entryPolicy.collapseGuard;
    if (!guard.enabled || guard.microStabilityDelayMs <= 0) {
      return { ok: true };
    }

    await sleep(guard.microStabilityDelayMs);
    const secondPool = await this.fetchFreshPool(poolAddress);
    if (!secondPool) {
      return {
        ok: false,
        reason: "fresh_filter_failed: micro-stability pool unavailable",
        metrics: { microDelayMs: guard.microStabilityDelayMs },
      };
    }

    const activeBinDrift = Math.abs(
      secondPool.activeBinId - firstPool.activeBinId,
    );
    const priceMovePct = pctMove(
      firstPool.currentPrice,
      secondPool.currentPrice,
    );
    const metrics = {
      microDelayMs: guard.microStabilityDelayMs,
      microActiveBinDrift: activeBinDrift,
      microPriceMovePct: priceMovePct ?? null,
    };
    if (activeBinDrift > guard.microMaxActiveBinDriftBins) {
      return {
        ok: false,
        reason: `micro_drift: active bin drift ${activeBinDrift} exceeds ${guard.microMaxActiveBinDriftBins}`,
        metrics,
      };
    }
    if (
      priceMovePct !== undefined &&
      priceMovePct > guard.microMaxPriceMovePct
    ) {
      return {
        ok: false,
        reason: `micro_drift: price moved ${priceMovePct.toFixed(2)}% exceeds ${guard.microMaxPriceMovePct}%`,
        metrics,
      };
    }

    return { ok: true };
  }

  private recentRealtimeForOpen(
    input: OpenPositionInput,
    limit: number,
  ): { events: RealtimeEvent[]; source: FreshRealtimeSource } {
    const live = this.deps.listener?.recentFor(input.poolAddress, limit) ?? [];
    if (live.length > 0) return { events: live, source: "listener" };

    if (input.paper === true) {
      const commandEvents = this.normalizeEntrySnapshotRealtimeEvents(
        input,
        limit,
      );
      if (commandEvents.length > 0) {
        return { events: commandEvents, source: "command_snapshot" };
      }
    }

    return {
      events: this.recentRealtimeFromSnapshotFile(input.poolAddress, limit),
      source: "snapshot_file",
    };
  }

  private normalizeEntrySnapshotRealtimeEvents(
    input: OpenPositionInput,
    limit: number,
  ): RealtimeEvent[] {
    const raw = input.entrySnapshot?.realtimeEvents;
    if (!Array.isArray(raw)) return [];

    const now = Date.now();
    const normalized: RealtimeEvent[] = [];
    for (const event of raw) {
      if (event.poolAddress !== input.poolAddress) continue;
      if (!REALTIME_EVENT_KINDS.has(event.kind)) continue;
      if (!Number.isFinite(event.timestamp) || event.timestamp <= 0) continue;
      if (event.timestamp - now > COMMAND_EVENT_MAX_FUTURE_MS) continue;

      normalized.push({
        kind: event.kind,
        poolAddress: input.poolAddress,
        ...(typeof event.signature === "string" && event.signature.length > 0
          ? { signature: event.signature }
          : {}),
        ...(typeof event.slot === "number" && Number.isFinite(event.slot)
          ? { slot: event.slot }
          : {}),
        timestamp: event.timestamp,
        ...(typeof event.amountUsd === "number" &&
        Number.isFinite(event.amountUsd)
          ? { amountUsd: event.amountUsd }
          : {}),
      });
    }
    return normalized.slice(-Math.max(0, limit));
  }

  private recentRealtimeFromSnapshotFile(
    poolAddress: string,
    limit: number,
  ): ReturnType<RealtimeListener["recentFor"]> {
    const snapshotPath = path.resolve(
      this.config.output.dataDir ?? "./data",
      "realtime-signals.json",
    );
    return recentForFromSnapshotFile(snapshotPath, poolAddress, limit);
  }

  private async resolveOpenSizing(
    input: OpenPositionInput,
  ): Promise<OpenSizingResolution> {
    const cfg = this.config.manager;
    if (typeof cfg.positionSizeUsd === "number" && cfg.positionSizeUsd > 0) {
      return {
        ok: true,
        source: "usd-override",
        input: { ...input, sizeUsd: cfg.positionSizeUsd },
      };
    }

    const hasSolSizing =
      typeof cfg.deployAmountSol === "number" ||
      typeof cfg.positionSizePct === "number" ||
      typeof cfg.maxDeployAmount === "number" ||
      typeof cfg.gasReserve === "number" ||
      typeof cfg.minSolToOpen === "number";
    if (!hasSolSizing) {
      return { ok: true, source: "input", input };
    }

    if (!this.deps.wallet.isConfigured()) {
      return { ok: true, source: "input", input };
    }

    const balanceSol = await this.deps.wallet.getBalanceSol();
    const minSolToOpen = cfg.minSolToOpen ?? 0;
    if (balanceSol < minSolToOpen) {
      return {
        ok: false,
        reason: `wallet SOL ${balanceSol.toFixed(4)} below minSolToOpen ${minSolToOpen}`,
      };
    }

    const gasReserve = cfg.gasReserve ?? 0;
    const deployableSol = Math.max(0, balanceSol - gasReserve);
    if (deployableSol <= 0) {
      return {
        ok: false,
        reason: `wallet SOL ${balanceSol.toFixed(4)} has no deployable balance after gasReserve ${gasReserve}`,
      };
    }

    const baseSol = cfg.deployAmountSol ?? deployableSol;
    const pctSol =
      typeof cfg.positionSizePct === "number"
        ? deployableSol * cfg.positionSizePct
        : deployableSol;
    const capSol = cfg.maxDeployAmount ?? Number.POSITIVE_INFINITY;
    const deploySol = Math.min(baseSol, pctSol, capSol, deployableSol);
    if (!Number.isFinite(deploySol) || deploySol <= 0) {
      return {
        ok: false,
        reason: `resolved deploy SOL is not positive (deployable=${deployableSol.toFixed(4)})`,
      };
    }

    const prices = await this.deps.jupiter.getPriceUsd([SOL_MINT]);
    const solPriceUsd = prices[SOL_MINT];
    if (
      typeof solPriceUsd !== "number" ||
      !Number.isFinite(solPriceUsd) ||
      solPriceUsd <= 0
    ) {
      return {
        ok: false,
        reason: "SOL/USD price unavailable for SOL-based position sizing",
      };
    }

    const sizeUsd = deploySol * solPriceUsd;
    const sizingNote = `sol-sizing deploy=${deploySol.toFixed(6)} SOL price=${solPriceUsd.toFixed(4)} USD`;
    return {
      ok: true,
      source: "sol-config",
      input: {
        ...input,
        sizeUsd,
        notes: input.notes ? `${input.notes}; ${sizingNote}` : sizingNote,
      },
      solContext: {
        balanceSol,
        deployableSol,
        deploySol,
        solPriceUsd,
      },
    };
  }

  private deriveHeuristic(
    position: Position,
    evaluation: PositionEvaluation,
  ): HeuristicDecision {
    const t = this.config.manager.thresholds;
    const pnlPct = evaluation.pnlPct * 100;

    // Track peak PnL (side-effect on position tracker)
    const prevPeak = position.peakPnlPct ?? pnlPct;
    const peakPnlPct = Math.max(prevPeak, pnlPct);
    if (pnlPct > prevPeak) {
      this.deps.tracker.update(position.positionPubkey, { peakPnlPct: pnlPct });
    }

    // 1a. Trailing TP — fire (armed in a previous cycle)
    if (t.trailingTakeProfit && position.trailingTpActive) {
      const dropPct = t.trailingDropPct ?? 1.5;
      const drop = peakPnlPct - pnlPct;
      if (drop >= dropPct) {
        return {
          kind: "close",
          reason: `trailing-TP: peak ${peakPnlPct.toFixed(2)}% → now ${pnlPct.toFixed(2)}% (drop ${drop.toFixed(2)}% >= ${dropPct}%)`,
          critical: true,
        };
      }
    }

    // 1b. Trailing TP — arm when trigger threshold reached
    if (
      t.trailingTakeProfit &&
      !position.trailingTpActive &&
      typeof t.trailingTriggerPct === "number" &&
      pnlPct >= t.trailingTriggerPct
    ) {
      this.deps.tracker.update(position.positionPubkey, {
        trailingTpActive: true,
      });
      this.log.info(
        {
          positionPubkey: position.positionPubkey,
          pnlPct,
          trailingTriggerPct: t.trailingTriggerPct,
        },
        "trailing-TP armed",
      );
    }

    // 1c. Simple take-profit (only when trailing-TP is disabled)
    if (
      !t.trailingTakeProfit &&
      typeof t.takeProfitPct === "number" &&
      pnlPct >= t.takeProfitPct
    ) {
      return {
        kind: "close",
        reason: `take-profit ${pnlPct.toFixed(2)}% >= ${t.takeProfitPct}%`,
        critical: true,
      };
    }

    // 2. Stop-loss
    if (typeof t.stopLossPct === "number" && pnlPct <= t.stopLossPct) {
      return {
        kind: "close",
        reason: `stop-loss ${pnlPct.toFixed(2)}% <= ${t.stopLossPct}%`,
        critical: true,
      };
    }

    // 3. IL ceiling
    if (evaluation.ilUsd >= t.maxIlUsd) {
      return {
        kind: "close",
        reason: `IL ${formatUsd(evaluation.ilUsd)} ≥ ceiling ${formatUsd(t.maxIlUsd)}`,
        critical: true,
      };
    }

    // 4. Far OOR bins
    const outOfRangeBins = (evaluation as any).outOfRangeBins as
      | number
      | undefined;
    if (
      typeof t.outOfRangeBinsToClose === "number" &&
      typeof outOfRangeBins === "number" &&
      outOfRangeBins >= t.outOfRangeBinsToClose
    ) {
      return {
        kind: "close",
        reason: `OOR bins ${outOfRangeBins} >= ${t.outOfRangeBinsToClose}`,
        critical: true,
      };
    }

    // 5. Timed OOR
    if (
      evaluation.outOfRangeMinutes >= t.outOfRangeMaxMinutes &&
      evaluation.inRangePct < (t.minInRangePctForOorClose ?? 0.4)
    ) {
      return {
        kind: "close",
        reason: `out-of-range ${evaluation.outOfRangeMinutes}m (in-range ${(evaluation.inRangePct * 100).toFixed(0)}%)`,
        critical: true,
      };
    }

    // 6. Low yield gate
    const feePerTvl24h = (evaluation as any).feePerTvl24h as number | undefined;
    if (
      typeof t.minFeePerTvl24h === "number" &&
      typeof feePerTvl24h === "number" &&
      evaluation.ageMinutes >= (t.minAgeBeforeYieldCheck ?? 60) &&
      feePerTvl24h < t.minFeePerTvl24h
    ) {
      return {
        kind: "close",
        reason: `low yield: fee/TVL ${feePerTvl24h.toFixed(3)}% < min ${t.minFeePerTvl24h}% after ${Math.round(evaluation.ageMinutes)}m`,
        critical: false,
      };
    }

    // 7. Max position age
    if (
      typeof t.maxPositionAgeMinutes === "number" &&
      evaluation.ageMinutes >= t.maxPositionAgeMinutes
    ) {
      return {
        kind: "close",
        reason: `max age reached: ${Math.round(evaluation.ageMinutes)}m >= ${t.maxPositionAgeMinutes}m`,
        critical: true,
      };
    }

    // 8. Strategy automation (reseed > compound > harvest)
    const strategyConfig = this.config.manager.strategyAutomation;
    if (strategyConfig) {
      const automatorResult = evaluateStrategyAutomation(
        position,
        strategyConfig,
        evaluation.claimableFees.usdValue,
        pnlPct,
        this.config.dryRun,
      );
      if (automatorResult.action.kind === "reseed") {
        return {
          kind: "close",
          reason: `strategy-automation: reseed (pnl ${pnlPct.toFixed(2)}% >= reseedMinPnlPct ${strategyConfig.reseedMinPnlPct ?? 0}%)`,
          critical: false,
        };
      }
      if (automatorResult.action.kind === "compound") {
        const { claimableUsd } = automatorResult.action;
        return {
          kind: "claim",
          reason: `strategy-automation: compound ${formatUsd(claimableUsd)} claimable`,
          critical: false,
        };
      }
      if (automatorResult.action.kind === "harvest") {
        const { claimableUsd } = automatorResult.action;
        return {
          kind: "claim",
          reason: `strategy-automation: harvest ${formatUsd(claimableUsd)} claimable`,
          critical: false,
        };
      }
    }

    // 9. Claim in-range fees
    if (
      evaluation.inRange &&
      evaluation.claimableFees.usdValue >= t.claimMinUsd
    ) {
      return {
        kind: "claim",
        reason: `claimable ${formatUsd(evaluation.claimableFees.usdValue)} ≥ ${formatUsd(t.claimMinUsd)} (in-range)`,
        critical: false,
      };
    }

    // 10. Hold
    return {
      kind: "hold",
      reason: `healthy: in-range=${evaluation.inRange}, PnL ${formatUsd(evaluation.pnlUsd)}, claimable ${formatUsd(evaluation.claimableFees.usdValue)}`,
      critical: false,
    };
  }

  private reconcile(
    heuristic: HeuristicDecision,
    llm: ManagerAction,
  ): ManagerAction {
    const llmConfident = (llm.confidence ?? 0) >= (this.config.manager.thresholds.llmConfidenceThreshold ?? 0.5);
    if (
      heuristic.critical &&
      heuristic.kind === "close" &&
      llm.kind !== "close"
    ) {
      this.log.info(
        { llmKind: llm.kind, heuristicReason: heuristic.reason },
        "overriding LLM with critical heuristic close",
      );
      return {
        kind: "close",
        reason: `${heuristic.reason} (override LLM=${llm.kind})`,
        confidence: 1,
        raw: llm.raw,
      };
    }
    if (!llmConfident) {
      return {
        kind: heuristic.kind,
        reason: `${heuristic.reason} (LLM low-confidence ${(llm.confidence ?? 0).toFixed(2)})`,
        confidence: llm.confidence,
        raw: llm.raw,
      };
    }
    return llm;
  }

  private async callManagerLlm(
    position: Position,
    evaluation: PositionEvaluation,
  ): Promise<ManagerAction | null> {
    const tags = deriveTags(position);
    const lessons = this.deps.lessonStore.findRelevant({
      tags,
      poolName: position.poolName,
      limit: this.config.manager.lessonsContextLimit,
    });
    const recentSignals =
      this.deps.listener?.recentFor(position.poolAddress, 10) ?? [];
    const memory = this.deps.memoryRouter?.forManager(position);

    const userPrompt = buildManagerUserPrompt({
      position,
      evaluation,
      thresholds: this.config.manager.thresholds,
      lessons,
      recentSignals,
      memory,
    });

    const resp = await this.deps.llm.generate({
      systemPrompt: this.managerSystemPrompt,
      userPrompt,
      temperature: 0.2,
      maxTokens: this.config.llm.managerMaxTokens ?? 600,
      timeoutMs: this.config.llm.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
      jsonMode: true,
    });

    if (!resp.ok || !resp.raw) {
      this.log.warn(
        {
          err: resp.error,
          positionPubkey: position.positionPubkey,
        },
        "manager LLM call failed",
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(resp.raw);
    } catch (err) {
      this.log.warn(
        {
          err,
          positionPubkey: position.positionPubkey,
          rawHead: resp.raw.slice(0, 200),
        },
        "manager LLM output not valid JSON",
      );
      return {
        kind: "skip",
        reason: "LLM JSON parse error",
        raw: resp.raw,
      };
    }

    const validated = ManagerDecisionSchema.safeParse(parsed);
    if (!validated.success) {
      this.log.warn(
        {
          issues: validated.error.issues,
          positionPubkey: position.positionPubkey,
        },
        "manager LLM output failed schema validation",
      );
      return {
        kind: "skip",
        reason: "LLM schema validation failed",
        raw: resp.raw,
      };
    }

    const decision = validated.data;
    const kind = decision.action.toLowerCase() as
      | "hold"
      | "claim"
      | "close"
      | "rebalance";
    return {
      kind,
      reason: decision.reasons.length > 0 ? decision.reasons.join("; ") : "llm",
      confidence: decision.confidence,
      newRangeBps: decision.rebalance?.newRangeBps,
      raw: resp.raw,
    };
  }

  // ------------------------------------------------------------------
  // internals — execution
  // ------------------------------------------------------------------

  private async reconcileMissingOnChainPosition(
    position: Position,
    cycleId: string,
  ): Promise<ClosedPosition | null> {
    if (position.dryRun) return null;

    let exists = true;
    try {
      exists = await this.deps.actions.positionAccountExists(
        position.positionPubkey,
      );
    } catch (err) {
      this.log.warn(
        { err, positionPubkey: position.positionPubkey },
        "position account existence check failed",
      );
      return null;
    }

    if (exists) return null;

    const evaluation = fallbackEvaluationFromPosition(position);
    const reason =
      "position account missing on-chain; reconciled as externally closed";
    const action: ManagerAction = {
      kind: "close",
      reason,
      confidence: 1,
    };
    const closed = buildClosedPosition({
      position,
      evaluation,
      exitReason: reason,
      signature: undefined,
    });

    this.recordManagerDecision(position, evaluation, action, cycleId);
    if (!this.shouldMutatePositionState(position)) {
      this.recordManagerActionResult(
        position,
        evaluation,
        action,
        true,
        cycleId,
      );
      this.log.info(
        { positionPubkey: position.positionPubkey },
        "missing on-chain position reconciliation simulated; tracker left unchanged",
      );
      return null;
    }
    this.deps.closedStore.add(closed);
    this.deps.tracker.remove(position.positionPubkey);
    this.recordManagerActionResult(position, evaluation, action, true, cycleId);
    this.log.warn(
      { positionPubkey: position.positionPubkey, pool: position.poolName },
      "tracked position missing on-chain; removed from open tracker",
    );
    return closed;
  }

  private async execute(
    position: Position,
    evaluation: PositionEvaluation,
    action: ManagerAction,
  ): Promise<{
    success: boolean;
    error?: string;
    closed?: ClosedPosition;
    newPosition?: Position;
  }> {
    const dryRun = this.config.dryRun;
    try {
      switch (action.kind) {
        case "hold":
        case "skip":
        case "error":
          return { success: true };
        case "claim": {
          if (position.dryRun) {
            // No on-chain position to claim from; fees are tracked in sim state.
            this.log.info(
              { positionPubkey: position.positionPubkey, dryRun: true },
              "claim skipped (simulated position)",
            );
            return { success: true };
          }
          const r = await this.deps.actions.claimFees({
            positionPubkey: position.positionPubkey,
            poolAddress: position.poolAddress,
            dryRun,
          });
          this.log.info(
            {
              positionPubkey: position.positionPubkey,
              signature: r.signature,
              dryRun: r.dryRun,
            },
            "claim executed",
          );
          if (!dryRun) {
            this.deps.tracker.update(position.positionPubkey, {
              notes: `last_claim=${new Date().toISOString()}`,
            });
          }
          return { success: true };
        }
        case "close": {
          if (position.dryRun) {
            // Simulated position — never on-chain; build ClosedPosition directly.
            const closed = buildClosedPosition({
              position,
              evaluation,
              exitReason: action.reason,
              signature: undefined,
            });
            this.log.info(
              {
                positionPubkey: position.positionPubkey,
                dryRun: true,
                pnlUsd: closed.realizedPnlUsd,
              },
              "close executed (simulated)",
            );
            if (this.shouldRecordOperationalPoolMemory(position)) {
              this.deps.poolMemoryStore?.record({
                poolAddress: position.poolAddress,
                poolName: position.poolAddress,
                exitReason: action.reason,
                pnlPct: evaluation.pnlPct * 100,
              });
            }
            return { success: true, closed };
          }
          const r = await this.deps.actions.closePosition({
            positionPubkey: position.positionPubkey,
            poolAddress: position.poolAddress,
            dryRun,
          });
          const closed = buildClosedPosition({
            position,
            evaluation,
            exitReason: action.reason,
            signature: r.signature,
          });
          this.log.info(
            {
              positionPubkey: position.positionPubkey,
              signature: r.signature,
              dryRun: r.dryRun,
              pnlUsd: closed.realizedPnlUsd,
            },
            "close executed",
          );
          await this.swapClosedTokensToSol(position, r);
          if (this.shouldRecordOperationalPoolMemory(position)) {
            this.deps.poolMemoryStore?.record({
              poolAddress: position.poolAddress,
              poolName: position.poolAddress,
              exitReason: action.reason,
              pnlPct: evaluation.pnlPct * 100,
            });
          }
          return { success: true, closed };
        }
        case "rebalance": {
          if (position.dryRun) {
            this.log.info(
              { positionPubkey: position.positionPubkey, dryRun: true },
              "rebalance skipped (simulated position)",
            );
            return { success: true };
          }
          const newRangeBps = action.newRangeBps || (this.config.manager.thresholds.fallbackRebalanceRangeBps ?? 1000);
          const r = await this.deps.actions.rebalance({
            positionPubkey: position.positionPubkey,
            newRangeBps,
            dryRun,
          });
          this.log.info(
            {
              positionPubkey: position.positionPubkey,
              newRangeBps,
              openSig: r.openSig,
              dryRun: r.dryRun,
            },
            "rebalance executed (SDK atomic)",
          );
          // Update tracker with new entry data (same position pubkey, new range).
          if (r.newPosition.positionPubkey) {
            this.deps.tracker.update(position.positionPubkey, {
              lowerBinId: r.newPosition.lowerBinId,
              upperBinId: r.newPosition.upperBinId,
              entryActiveBinId: r.newPosition.entryActiveBinId,
              entryPrice: r.newPosition.entryPrice,
              entryTimestamp: r.newPosition.entryTimestamp,
              entryAmountX: r.newPosition.entryAmountX,
              entryAmountY: r.newPosition.entryAmountY,
              txSignature: r.openSig,
              notes: `rebalanced at ${new Date().toISOString()}`,
            });
          }
          return { success: true, newPosition: r.newPosition };
        }
        default: {
          const _exhaustive: never = action.kind;
          return {
            success: false,
            error: `unknown action ${String(_exhaustive)}`,
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        { err, positionPubkey: position.positionPubkey, action: action.kind },
        "action execution failed",
      );
      return { success: false, error: message };
    }
  }

  // ------------------------------------------------------------------
  // internals — lessons
  // ------------------------------------------------------------------

  private async generateLesson(closed: ClosedPosition): Promise<Lesson | null> {
    const closedTags = deriveTags(closed.position);
    const similar = this.deps.lessonStore.findRelevant({
      tags: closedTags,
      poolName: closed.position.poolName,
      limit: 5,
    });
    const memory = this.deps.memoryRouter?.forPostMortem(closed, similar);
    const userPrompt = buildPostMortemUserPrompt(closed, similar, memory);
    const resp = await this.deps.llm.generate({
      systemPrompt: this.postMortemSystemPrompt,
      userPrompt,
      temperature: 0.2,
      maxTokens: this.config.llm.postMortemMaxTokens ?? 500,
      timeoutMs: this.config.llm.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
      jsonMode: true,
    });

    if (!resp.ok || !resp.raw) {
      this.log.warn(
        {
          err: resp.error,
          positionPubkey: closed.position.positionPubkey,
        },
        "post-mortem LLM call failed",
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(resp.raw);
    } catch (err) {
      this.log.warn(
        {
          err,
          rawHead: resp.raw.slice(0, 200),
        },
        "post-mortem LLM output not valid JSON",
      );
      return null;
    }

    const validated = PostMortemSchema.safeParse(parsed);
    if (!validated.success) {
      this.log.warn(
        { issues: validated.error.issues },
        "post-mortem LLM output failed schema validation",
      );
      return null;
    }

    if ("duplicateOf" in validated.data) {
      this.log.info(
        {
          duplicateOf: validated.data.duplicateOf,
          closedId: closed.position.positionPubkey,
        },
        "post-mortem returned duplicate; skipping new lesson",
      );
      return null;
    }

    const data = validated.data;
    const lesson: Lesson = {
      id: `L-${new Date().toISOString().slice(0, 10)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      timestamp: Date.now(),
      poolName: closed.position.poolName,
      tags: data.tags,
      positiveTakeaway: data.positiveTakeaway ?? null,
      mistake: data.mistake ?? null,
      ruleForFuture: data.ruleForFuture,
      context: {
        entry: data.context?.entry ?? "",
        exit: data.context?.exit ?? closed.exitReason,
        pnlUsd:
          typeof data.context?.pnlUsd === "number"
            ? data.context.pnlUsd
            : closed.realizedPnlUsd,
      },
    };
    const stored = this.deps.lessonStore.add(lesson);
    this.log.info(
      { lessonId: stored.id, poolName: stored.poolName, tags: stored.tags },
      "lesson learned",
    );
    this.recordLessonMined(
      `Post-mortem lesson ${stored.id}: ${stored.ruleForFuture}`,
      { added: 1, deduped: 0 },
      closed.position.cycleIdOnEnter,
      stored.id,
      closed.position,
    );
    return stored;
  }

  private recordManagerDecision(
    position: Position,
    evaluation: PositionEvaluation,
    action: ManagerAction,
    cycleId: string,
  ): void {
    this.deps.decisionJournal?.safeAppend({
      actor: "MANAGER",
      event: "MANAGER_DECISION",
      subject: subjectFromPosition(position),
      action: action.kind.toUpperCase(),
      status: "PROPOSED",
      summary: `${action.kind.toUpperCase()} ${position.poolName}: ${action.reason}`,
      reasons: [action.reason],
      risks: [],
      metrics: managerMetrics(evaluation),
      rejectedAlternatives: ["hold", "claim", "close", "rebalance"].filter(
        (kind) => kind !== action.kind,
      ),
      linkedIds: {
        cycleId,
        cycleIdOnEnter: position.cycleIdOnEnter,
      },
      dryRun: this.config.dryRun || position.dryRun,
      raw: action.raw,
    });
  }

  private recordManagerActionResult(
    position: Position,
    evaluation: PositionEvaluation,
    action: ManagerAction,
    success: boolean,
    cycleId: string,
    error?: string,
  ): void {
    this.deps.decisionJournal?.safeAppend({
      actor: "MANAGER",
      event: success ? "ACTION_SUCCESS" : "ACTION_FAILED",
      subject: subjectFromPosition(position),
      action: action.kind.toUpperCase(),
      status: success ? "SUCCESS" : "FAILED",
      summary: `${action.kind.toUpperCase()} ${success ? "succeeded" : "failed"} for ${position.poolName}`,
      reasons: [action.reason],
      risks: error ? [error] : [],
      metrics: managerMetrics(evaluation),
      rejectedAlternatives: [],
      linkedIds: {
        cycleId,
        cycleIdOnEnter: position.cycleIdOnEnter,
      },
      dryRun: this.config.dryRun || position.dryRun,
      raw: action.raw,
    });
  }

  private recordOpenNoDeploy(
    input: OpenPositionInput,
    reason: string,
    screeningContext?: { cycleId: string },
  ): void {
    this.deps.decisionJournal?.safeAppend({
      actor: "EXECUTOR",
      event: "NO_DEPLOY",
      subject: { poolAddress: input.poolAddress, tokenSymbols: [] },
      action: "OPEN",
      status: "SKIPPED",
      summary: `No deploy for ${input.poolAddress}: ${reason}`,
      reasons: [reason],
      risks: [],
      metrics: {
        sizeUsd: input.sizeUsd,
        rangeBps: input.rangeBps,
        openPositions: this.deps.tracker.count(),
        maxOpenPositions: this.config.manager.maxOpenPositions,
      },
      rejectedAlternatives: ["OPEN_POSITION"],
      linkedIds: {
        cycleId: screeningContext?.cycleId,
        cycleIdOnEnter: input.cycleIdOnEnter,
      },
      dryRun: this.config.dryRun || input.dryRun === true,
    });
  }

  private recordOpenResult(
    input: OpenPositionInput,
    opened: Position | null,
    success: boolean,
    screeningContext?: { cycleId: string },
    error?: string,
  ): void {
    const isPaperOpen =
      input.paper === true || opened?.notes?.includes("paper=true") === true;
    this.deps.decisionJournal?.safeAppend({
      actor: "EXECUTOR",
      event: success ? "OPEN_SUCCESS" : "OPEN_FAILED",
      subject: opened
        ? subjectFromPosition(opened)
        : { poolAddress: input.poolAddress, tokenSymbols: [] },
      action: "OPEN",
      status: success ? "SUCCESS" : "FAILED",
      summary: `${success ? "Opened" : "Failed to open"} position for ${
        opened?.poolName ?? input.poolAddress
      }`,
      reasons: success
        ? [isPaperOpen ? "paper_open" : "open position attempted"]
        : [],
      risks: error ? [error] : [],
      metrics: {
        sizeUsd: input.sizeUsd,
        rangeBps: input.rangeBps,
        entryValueUsd: opened?.entryValueUsd ?? null,
      },
      rejectedAlternatives: [],
      linkedIds: {
        cycleId: screeningContext?.cycleId,
        cycleIdOnEnter: input.cycleIdOnEnter,
        positionPubkey: opened?.positionPubkey,
      },
      dryRun: this.config.dryRun || input.dryRun === true,
    });
  }

  private recordLessonMined(
    summary: string,
    metrics: Record<string, string | number | boolean | null>,
    cycleId?: string,
    lessonId?: string,
    position?: Position,
  ): void {
    this.deps.decisionJournal?.safeAppend({
      actor: "LEARNING",
      event: "LESSON_MINED",
      subject: position ? subjectFromPosition(position) : { tokenSymbols: [] },
      action: "MINE_LESSON",
      status: "INFO",
      summary,
      reasons: [summary],
      risks: [],
      metrics,
      rejectedAlternatives: [],
      linkedIds: { cycleId, lessonId },
      dryRun: this.config.dryRun,
    });
  }

  // ------------------------------------------------------------------

  private loadPrompt(file: string, name: string): string {
    try {
      return fs.readFileSync(file, "utf-8");
    } catch (err) {
      this.log.error({ err, file, name }, "failed to read prompt");
      return `You are the ${name}. Respond ONLY with a single JSON object.`;
    }
  }

  // ---------- watchdog accessors ----------

  /** Timestamp (ms) of the last completed cron-driven cycle, or null. */
  getLastCycleAt(): number | null {
    return this.lastCycleAt;
  }

  /** Current cron expression (e.g. "*\/10 * * * *"). */
  getCronExpression(): string {
    return this.config.manager.cron;
  }

  /** Whether the cron task is currently registered. */
  isCronRunning(): boolean {
    return this.cronTask !== null;
  }
}

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------

function fallbackEvaluationFromPosition(
  position: Position,
): PositionEvaluation {
  const last = position.lastEvaluation;
  const now = Date.now();
  return {
    position,
    evaluatedAt: last?.evaluatedAt ?? now,
    currentActiveBinId: last?.currentActiveBinId ?? position.entryActiveBinId,
    inRange: last?.inRange ?? false,
    inRangePct: last?.inRangePct ?? 0,
    outOfRangeMinutes: last?.outOfRangeMinutes ?? 0,
    currentPrice: last?.currentPrice ?? position.entryPrice,
    currentAmountX: last?.currentAmountX ?? position.entryAmountX,
    currentAmountY: last?.currentAmountY ?? position.entryAmountY,
    currentValueUsd: last?.currentValueUsd ?? position.entryValueUsd,
    claimableFees: last?.claimableFees ?? {
      tokenX: "0",
      tokenY: "0",
      usdValue: 0,
    },
    pnlUsd: last?.pnlUsd ?? 0,
    pnlPct: last?.pnlPct ?? 0,
    ilUsd: last?.ilUsd ?? 0,
    ageMinutes:
      last?.ageMinutes ?? Math.max(0, (now - position.entryTimestamp) / 60_000),
    ...(last?.remoteMeteoraPnl
      ? { remoteMeteoraPnl: last.remoteMeteoraPnl }
      : {}),
  };
}

function rawToBigInt(raw: string | undefined): bigint {
  try {
    return BigInt(raw ?? "0");
  } catch {
    return 0n;
  }
}

function addRawAmounts(a: string | undefined, b: string | undefined): bigint {
  return rawToBigInt(a) + rawToBigInt(b);
}

function rawToUiNumber(raw: string, decimals: number): number {
  const amount = rawToBigInt(raw);
  if (amount <= 0n) return 0;
  const safeDecimals = Math.max(0, decimals);
  const divisor = 10n ** BigInt(safeDecimals);
  const whole = amount / divisor;
  const remainder = amount % divisor;
  if (safeDecimals === 0) return Number(whole);
  const frac = remainder.toString().padStart(safeDecimals, "0");
  const n = Number(`${whole.toString()}.${frac}`);
  return Number.isFinite(n) ? n : 0;
}

function toPercentPoints(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value <= 1 ? value * 100 : value;
}

function shallowTopLevelDiff(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (!deepEqualManager(a[k], b[k])) out.push(k);
  }
  return out;
}

function deepEqualManager(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualManager(a[i], b[i])) return false;
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
    if (!deepEqualManager(ao[k], bo[k])) return false;
  }
  return true;
}

function deriveTags(position: Position): string[] {
  return [
    position.tokenX.symbol,
    position.tokenY.symbol,
    `bin_step_${position.binStep}`,
    position.poolName,
  ];
}

function subjectFromPosition(position: Position): {
  poolAddress: string;
  poolName: string;
  positionPubkey: string;
  tokenSymbols: string[];
} {
  return {
    poolAddress: position.poolAddress,
    poolName: position.poolName,
    positionPubkey: position.positionPubkey,
    tokenSymbols: [position.tokenX.symbol, position.tokenY.symbol],
  };
}

function managerMetrics(
  evaluation: PositionEvaluation,
): Record<string, string | number | boolean | null> {
  return {
    inRange: evaluation.inRange,
    inRangePct: evaluation.inRangePct,
    outOfRangeMinutes: evaluation.outOfRangeMinutes,
    currentValueUsd: evaluation.currentValueUsd,
    claimableFeesUsd: evaluation.claimableFees.usdValue,
    pnlUsd: evaluation.pnlUsd,
    pnlPct: evaluation.pnlPct,
    ilUsd: evaluation.ilUsd,
    ageMinutes: evaluation.ageMinutes,
    currentActiveBinId: evaluation.currentActiveBinId,
    currentPrice: evaluation.currentPrice,
  };
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$-";
  return `$${n.toFixed(2)}`;
}

function paperPositionId(): string {
  return `paper-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function tokenToPaperPositionToken(t: Pool["tokenX"]): PositionToken {
  return { mint: t.mint, symbol: t.symbol, decimals: t.decimals };
}

function resolvePaperDepositSide(pool: Pool): "X" | "Y" {
  const xQuote = QUOTE_MINTS.has(pool.tokenX.mint);
  const yQuote = QUOTE_MINTS.has(pool.tokenY.mint);
  if (yQuote && !xQuote) return "Y";
  if (xQuote && !yQuote) return "X";
  if (xQuote && yQuote) {
    return pool.tokenX.mint === SOL_MINT ? "X" : "Y";
  }
  throw new Error(
    `paper_open: cannot determine single-sided deposit token for ${pool.name}`,
  );
}

function paperDepositAmounts(
  pool: Pool,
  depositSide: "X" | "Y",
  input: OpenPositionInput,
): { amountX: string; amountY: string } {
  const priceX = pool.tokenX.priceUsd;
  const priceY = pool.tokenY.priceUsd;
  let amountX = "0";
  let amountY = "0";

  if (depositSide === "Y") {
    if (typeof priceY === "number" && priceY > 0) {
      amountY = rawFromUsdString(input.sizeUsd, priceY, pool.tokenY.decimals);
    } else if (
      typeof priceX === "number" &&
      priceX > 0 &&
      pool.currentPrice > 0
    ) {
      amountY = rawFromUsdString(
        input.sizeUsd,
        priceX / pool.currentPrice,
        pool.tokenY.decimals,
      );
    }
  } else if (typeof priceX === "number" && priceX > 0) {
    amountX = rawFromUsdString(input.sizeUsd, priceX, pool.tokenX.decimals);
  } else if (
    typeof priceY === "number" &&
    priceY > 0 &&
    pool.currentPrice > 0
  ) {
    amountX = rawFromUsdString(
      input.sizeUsd,
      priceY * pool.currentPrice,
      pool.tokenX.decimals,
    );
  }

  return { amountX, amountY };
}

function rawFromUsdString(
  usd: number,
  priceUsd: number,
  decimals: number,
): string {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return "0";
  }
  const tokenAmount = usd / priceUsd;
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) return "0";
  const factor = Math.pow(10, decimals);
  const raw = Math.floor(tokenAmount * factor);
  if (!Number.isFinite(raw) || raw <= 0) return "0";
  return BigInt(raw).toString();
}

function isZeroRaw(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || /^0+$/.test(trimmed);
}

interface ManagerPromptInput {
  position: Position;
  evaluation: PositionEvaluation;
  thresholds: UserConfig["manager"]["thresholds"];
  lessons: Lesson[];
  recentSignals: Array<{ kind: string; amountUsd?: number; timestamp: number }>;
  memory?: PromptMemoryBundle;
}

function buildManagerUserPrompt(input: ManagerPromptInput): string {
  const { position, evaluation, thresholds, lessons, recentSignals, memory } =
    input;
  const signalSummary: Record<string, number> = {};
  for (const s of recentSignals) {
    signalSummary[s.kind] = (signalSummary[s.kind] ?? 0) + 1;
  }
  const snapshot = {
    entry: {
      positionPubkey: position.positionPubkey,
      pool: { address: position.poolAddress, name: position.poolName },
      tokens: { x: position.tokenX.symbol, y: position.tokenY.symbol },
      binStep: position.binStep,
      range: {
        lowerBinId: position.lowerBinId,
        upperBinId: position.upperBinId,
      },
      entryActiveBinId: position.entryActiveBinId,
      entryPrice: position.entryPrice,
      entryValueUsd: position.entryValueUsd,
      entryTimestamp: position.entryTimestamp,
      strategyType: position.strategyType,
      dryRun: position.dryRun,
    },
    evaluation: {
      currentActiveBinId: evaluation.currentActiveBinId,
      inRange: evaluation.inRange,
      inRangePct: evaluation.inRangePct,
      outOfRangeMinutes: evaluation.outOfRangeMinutes,
      currentPrice: evaluation.currentPrice,
      currentValueUsd: evaluation.currentValueUsd,
      claimableFeesUsd: evaluation.claimableFees.usdValue,
      pnlUsd: evaluation.pnlUsd,
      pnlPct: evaluation.pnlPct,
      ilUsd: evaluation.ilUsd,
      ageMinutes: evaluation.ageMinutes,
      // Authoritative numbers from Meteora's PnL API (when available). These
      // already overlay pnlUsd / ilUsd / claimableFeesUsd above, but the raw
      // breakdown helps the LLM reason about claimed-vs-unclaimed fees and
      // total deposits/withdrawals.
      remoteMeteoraPnl: evaluation.remoteMeteoraPnl,
    },
    thresholds,
    recentSignals: {
      countsByKind: signalSummary,
      last5: recentSignals.slice(-5),
    },
    lessons: lessons.map((l) => ({
      id: l.id,
      tags: l.tags,
      ruleForFuture: l.ruleForFuture,
      mistake: l.mistake,
      positiveTakeaway: l.positiveTakeaway,
      context: l.context,
    })),
    ...(hasPromptMemory(memory) ? { memory } : {}),
  };
  return [
    "Position snapshot follows. Decide HOLD / CLAIM / CLOSE / REBALANCE per system spec.",
    "If you use memory, cite journalId or lessonId inside reasons/risks/notes.",
    "Respond ONLY with the JSON object specified by the system prompt.",
    "",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}

function buildPostMortemUserPrompt(
  closed: ClosedPosition,
  existingSimilarLessons: Lesson[] = [],
  memory?: PromptMemoryBundle,
): string {
  const payload = {
    existingSimilarLessons: existingSimilarLessons.map((l) => ({
      id: l.id,
      ruleForFuture: l.ruleForFuture,
      tags: l.tags,
    })),
    entry: {
      pool: {
        address: closed.position.poolAddress,
        name: closed.position.poolName,
      },
      tokens: {
        x: closed.position.tokenX.symbol,
        y: closed.position.tokenY.symbol,
      },
      binStep: closed.position.binStep,
      range: {
        lowerBinId: closed.position.lowerBinId,
        upperBinId: closed.position.upperBinId,
      },
      entryActiveBinId: closed.position.entryActiveBinId,
      entryPrice: closed.position.entryPrice,
      entryValueUsd: closed.position.entryValueUsd,
      entryTimestamp: closed.position.entryTimestamp,
      cycleIdOnEnter: closed.position.cycleIdOnEnter,
      strategyType: closed.position.strategyType,
    },
    exit: {
      closedAt: closed.closedAt,
      exitReason: closed.exitReason,
      exitValueUsd: closed.exitValueUsd,
      totalFeesUsdEarned: closed.totalFeesUsdEarned,
      realizedPnlUsd: closed.realizedPnlUsd,
      realizedPnlPct: closed.realizedPnlPct,
      realizedIlUsd: closed.realizedIlUsd,
      ageMinutes: closed.ageMinutes,
      finalEvaluation: {
        inRange: closed.finalEvaluation.inRange,
        inRangePct: closed.finalEvaluation.inRangePct,
        outOfRangeMinutes: closed.finalEvaluation.outOfRangeMinutes,
        currentPrice: closed.finalEvaluation.currentPrice,
        currentValueUsd: closed.finalEvaluation.currentValueUsd,
      },
    },
    ...(hasPromptMemory(memory) ? { memory } : {}),
  };
  return [
    "Closed position post-mortem. Produce ONE lesson per the system spec.",
    "If memory affects the lesson or duplicate check, cite journalId or lessonId in context.",
    "Respond ONLY with the JSON object specified by the system prompt.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function toPositionLastEvaluation(
  evaluation: PositionEvaluation,
): PositionLastEvaluation {
  return {
    evaluatedAt: evaluation.evaluatedAt,
    currentActiveBinId: evaluation.currentActiveBinId,
    inRange: evaluation.inRange,
    inRangePct: evaluation.inRangePct,
    outOfRangeMinutes: evaluation.outOfRangeMinutes,
    currentPrice: evaluation.currentPrice,
    currentAmountX: evaluation.currentAmountX,
    currentAmountY: evaluation.currentAmountY,
    currentValueUsd: evaluation.currentValueUsd,
    claimableFees: evaluation.claimableFees,
    pnlUsd: evaluation.pnlUsd,
    pnlPct: evaluation.pnlPct,
    ilUsd: evaluation.ilUsd,
    ageMinutes: evaluation.ageMinutes,
    ...(evaluation.remoteMeteoraPnl
      ? { remoteMeteoraPnl: evaluation.remoteMeteoraPnl }
      : {}),
  };
}

function managerLoopPercent(completed: number, total: number): number {
  if (total <= 0) return 86;
  return 10 + (completed / total) * 76;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pctMove(from: number, to: number): number | undefined {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
    return undefined;
  }
  return (Math.abs(to - from) / Math.abs(from)) * 100;
}

function buildClosedPosition(args: {
  position: Position;
  evaluation: PositionEvaluation;
  exitReason: string;
  signature?: string;
}): ClosedPosition {
  const { position, evaluation, exitReason, signature } = args;
  // Prefer authoritative fee accrual from Meteora's PnL API: claimed + unclaimed.
  // Fall back to current claimable balance when the remote feed is unavailable.
  const remote = evaluation.remoteMeteoraPnl;
  const totalFeesUsdEarned = remote
    ? remote.totalFeeUsdClaimed + remote.unclaimedFeeUsd
    : evaluation.claimableFees.usdValue;
  return {
    position,
    closedAt: Date.now(),
    exitReason,
    exitValueUsd: evaluation.currentValueUsd,
    totalFeesUsdEarned,
    realizedPnlUsd: evaluation.pnlUsd,
    realizedPnlPct: evaluation.pnlPct,
    realizedIlUsd: normalizeIlLossUsd(evaluation.ilUsd),
    ageMinutes: evaluation.ageMinutes,
    finalEvaluation: evaluation,
    closeTxSignature: signature,
  };
}
