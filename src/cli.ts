#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import Table from "cli-table3";

import {
  loadConfig,
  configPath,
  getWalletPrivateKey,
  getOkxApiKey,
  getOkxPassphrase,
  getOkxProjectId,
  getOkxSecretKey,
  getTelegramConfigFromEnv,
} from "./config/config.js";
import { logger, childLogger } from "./utils/logger.js";
import { DecisionLogger } from "./utils/decision-logger.js";
import { JsonlEmitter } from "./utils/jsonl-emitter.js";
import { RealtimeSignalSnapshotStore } from "./utils/realtime-signal-snapshot.js";
import { ConfigWatcher } from "./utils/config-watcher.js";
import { CommandConsumer, type BotCommand } from "./utils/command-consumer.js";
import {
  renderResultsTable,
  renderDecisionDetail,
  fmtUsd,
  fmtPct,
  shortAddr,
} from "./utils/formatter.js";
import { reviewDecisions } from "./utils/review.js";

import { MeteoraTools } from "./tools/meteora.tools.js";
import { JupiterTools } from "./tools/jupiter.tools.js";
import { OkxTools } from "./tools/okx.tools.js";
import { MeteoraPnlTools } from "./tools/meteora-pnl.tools.js";
import { LpAgentTools } from "./tools/lpagent.tools.js";
import { createConnection } from "./tools/helius.tools.js";
import { WalletTools } from "./tools/wallet.tools.js";
import { MeteoraActions } from "./tools/meteora-actions.tools.js";
import { JupiterSwapClient } from "./tools/jupiter-swap.tools.js";
import { CapitalManager } from "./agents/capital-manager.js";
import { CleanupRunner } from "./agents/cleanup-runner.js";
import { RealtimeListener } from "./agents/realtime.listener.js";
import { ScreenerAgent } from "./agents/screener.agent.js";
import { ManagerAgent, type ManagerDeps } from "./agents/manager.agent.js";
import { PositionTracker } from "./agents/position-tracker.js";
import { ClosedPositionStore } from "./agents/closed-position-store.js";
import { TradeLedger } from "./agents/trade-ledger.js";
import { TradingCircuitBreaker } from "./agents/circuit-breaker.js";
import { LessonStore } from "./agents/lesson-store.js";
import { PositionEvaluator } from "./agents/position-evaluator.js";
import { createLlmProvider } from "./llm/factory.js";
import { JsonlStore } from "./learning/jsonl-store.js";
import { EvidenceIndex } from "./learning/evidence-index.js";
import { LearningRecorder } from "./learning/recorder.js";
import { OutcomeScheduler } from "./learning/outcome-scheduler.js";
import { EntryOutcomeComputer } from "./learning/entry-outcome.js";
import { RealizedOutcomeComputer } from "./learning/realized-outcome.js";
import { OutcomeCollector } from "./learning/outcome-collector.js";
import { ShadowRanker } from "./learning/shadow-ranker.js";
import { LessonMiner } from "./learning/lesson-miner.js";
import { LearningSnapshotEmitter } from "./learning/snapshot-emitter.js";
import { SignalWeightsEmitter } from "./learning/signal-weights.js";
import { DecisionJournal } from "./memory/decision-journal.js";
import { MemoryRouter } from "./memory/memory-router.js";
import { TelegramNotifier } from "./notifications/telegram.js";
import { formatProgressLine, type ProgressSink } from "./utils/progress.js";
import { pnlPctFromUsd, riskAdjustedLegacyPnlUsd } from "./utils/pnl.js";

import type {
  UserConfig,
  RealtimeEvent,
  ScreeningResult,
  ManagerCycleReport,
  ManagerActionKind,
  LearningDecision,
  LearningOutcome,
  LearningLesson,
  ShadowScore,
  DecisionJournalEntry,
  BotProgressEvent,
  EntrySnapshot,
  OpenPositionInput,
} from "./types/index.js";
import { BlacklistStore } from "./agents/blacklist-store.js";
import { PoolMemoryStore } from "./agents/pool-memory-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

interface PackageJsonShape {
  version?: string;
  name?: string;
}

function readPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "../package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as PackageJsonShape;
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fatal(err: unknown): never {
  logger.error({ err }, "command failed");
  console.error(chalk.red(`✗ ${getErrorMessage(err)}`));
  process.exit(1);
}

function applyGlobalOptions(opts: { verbose?: boolean }): void {
  if (opts.verbose) {
    process.env.LOG_LEVEL = "debug";
  }
}

interface ProgressSpinner {
  text: string;
  isSpinning?: boolean;
}

function createProgressSink(opts: {
  spinner?: ProgressSpinner;
  telegram?: TelegramNotifier | null;
  terminal?: boolean;
}): ProgressSink {
  let lastPrinted = "";
  return (event: BotProgressEvent): void => {
    const line = formatProgressLine(event);
    if (opts.spinner?.isSpinning) {
      opts.spinner.text = line;
    } else if (opts.terminal !== false && line !== lastPrinted) {
      lastPrinted = line;
      console.log(chalk.gray(line));
    }
    opts.telegram?.notifyProgress(event);
  };
}

function maskApiKeyInUrl(url: string): string {
  return url
    .replace(/(api[-_]?key=)[^&\s]+/gi, "$1***")
    .replace(/(\/\/[^/]*\/v\d+\/[^/]*?)\/[A-Za-z0-9-]{20,}/g, "$1/***");
}

function maskConfig(cfg: UserConfig): UserConfig {
  const cloned = JSON.parse(JSON.stringify(cfg)) as UserConfig;
  cloned.rpc.url = maskApiKeyInUrl(cloned.rpc.url);
  cloned.rpc.wsUrl = maskApiKeyInUrl(cloned.rpc.wsUrl);
  cloned.meteora.apiUrl = maskApiKeyInUrl(cloned.meteora.apiUrl);
  cloned.jupiter.baseUrl = maskApiKeyInUrl(cloned.jupiter.baseUrl);
  if (cloned.jupiter.apiKey) {
    cloned.jupiter.apiKey = "***";
  }
  if (cloned.okx?.apiKey) {
    cloned.okx.apiKey = "***";
  }
  if (cloned.llm.baseUrl) {
    cloned.llm.baseUrl = maskApiKeyInUrl(cloned.llm.baseUrl);
  }
  return cloned;
}

interface JsonlEmitters {
  candidates: JsonlEmitter;
  llmRuns: JsonlEmitter;
  progress: JsonlEmitter;
  commands: JsonlEmitter;
}

interface BuiltDeps {
  config: UserConfig;
  meteora: MeteoraTools;
  jupiter: JupiterTools;
  okx: OkxTools;
  meteoraPnl?: MeteoraPnlTools;
  lpagent?: LpAgentTools;
  decisionLogger: DecisionLogger;
  emitters: JsonlEmitters;
  signalSnapshot: RealtimeSignalSnapshotStore;
}

function buildDeps(configPathOverride?: string): BuiltDeps {
  const config = loadConfig(configPathOverride);
  const connection = createConnection(config.rpc.url, config.rpc.commitment);
  const meteora = new MeteoraTools({
    apiUrl: config.meteora.apiUrl,
    programId: config.meteora.programId,
    connection,
    timeframe: config.meteora.timeframe,
    category: config.meteora.category,
  });
  const jupiter = new JupiterTools({
    baseUrl: config.jupiter.baseUrl,
    apiKey: config.jupiter.apiKey,
  });
  // OKX Web3 connector. Public enrichment is enabled by default; signed
  // credentials are optional and only add authenticated request headers.
  const okxEnabled = config.okx.enabled !== false;
  const okx = new OkxTools({
    baseUrl: config.okx.baseUrl,
    apiKey: okxEnabled ? config.okx.apiKey || getOkxApiKey() : undefined,
    secretKey: okxEnabled ? getOkxSecretKey() : undefined,
    passphrase: okxEnabled ? getOkxPassphrase() : undefined,
    projectId: okxEnabled ? getOkxProjectId() : undefined,
    chainShortName: config.okx.chainShortName,
    enabled: okxEnabled,
  });
  const meteoraPnl =
    config.meteoraPnl.enabled !== false
      ? new MeteoraPnlTools({ baseUrl: config.meteoraPnl.baseUrl })
      : undefined;
  const lpagent =
    config.lpagent?.enabled && config.lpagent.apiKey
      ? new LpAgentTools({
          baseUrl: config.lpagent.baseUrl,
          apiKey: config.lpagent.apiKey,
          cacheTtlMs: config.lpagent.pollIntervalMs,
        })
      : undefined;
  const decisionLogger = new DecisionLogger(config.output.decisionLogPath);

  // Build append-only JSONL emitters only for streams that need history.
  // Realtime signals use a bounded rolling snapshot instead of a large JSONL
  // stream; positions are persisted in manager.positionsFile.
  const dataDir = path.resolve(config.output.dataDir);
  const emitters: JsonlEmitters = {
    candidates: new JsonlEmitter(path.join(dataDir, "candidates.jsonl")),
    llmRuns: new JsonlEmitter(path.join(dataDir, "llm-runs.jsonl")),
    progress: new JsonlEmitter(path.join(dataDir, "progress.jsonl")),
    commands: new JsonlEmitter(path.join(dataDir, "commands.jsonl")),
  };
  const signalSnapshot = new RealtimeSignalSnapshotStore({
    filePath: path.join(dataDir, "realtime-signals.json"),
  });

  return {
    config,
    meteora,
    jupiter,
    okx,
    meteoraPnl,
    lpagent,
    decisionLogger,
    emitters,
    signalSnapshot,
  };
}

async function buildManagerDeps(
  config: UserConfig,
  base: BuiltDeps,
  listener?: RealtimeListener,
): Promise<ManagerDeps> {
  const connection = createConnection(config.rpc.url, config.rpc.commitment);
  const wallet = new WalletTools({
    connection,
    privateKeyBase58: getWalletPrivateKey(),
  });
  const actions = new MeteoraActions({
    connection,
    wallet,
    meteora: base.meteora,
    ...(typeof config.manager.maxBinsPerSide === "number"
      ? { maxBinsPerSide: config.manager.maxBinsPerSide }
      : {}),
  });
  const tracker = new PositionTracker({
    filePath: config.manager.positionsFile,
  });
  const safetyDataDir = path.resolve(config.output.dataDir);
  const tradeLedger = new TradeLedger({
    filePath: path.join(safetyDataDir, "trade-log.jsonl"),
  });
  const circuitBreaker = new TradingCircuitBreaker({
    filePath: path.join(safetyDataDir, "circuit-breaker.json"),
    maxConsecutiveLosses: config.safety.circuitBreaker.maxConsecutiveLosses,
  });
  const closedStore = new ClosedPositionStore({
    filePath: config.manager.closedPositionsFile,
    // Forward only LIVE (non-dry-run) closes to the safety layer.
    onClose: (entry) => {
      if (entry.position.dryRun) return;
      tradeLedger.recordClose({
        poolAddress: entry.position.poolAddress,
        poolName: entry.position.poolName,
        sizeUsd: entry.position.entryValueUsd,
        pnlUsd: entry.realizedPnlUsd,
        pnlPct: entry.realizedPnlPct,
        exitReason: entry.exitReason,
        ageMinutes: entry.ageMinutes,
        positionPubkey: entry.position.positionPubkey,
      });
      circuitBreaker.recordTrade(entry.realizedPnlUsd);
    },
  });
  const lessonStore = new LessonStore({ filePath: config.manager.lessonsFile, lessonRecencyDays: config.learning.lessonRecencyDays });
  const evaluator = new PositionEvaluator({
    actions,
    meteora: base.meteora,
    jupiter: base.jupiter,
    pnl: base.meteoraPnl,
    samplingWindowMinutes: config.manager.samplingWindowMinutes,
  });
  const jupiterSwap = config.manager.postCloseSwap?.enabled
    ? new JupiterSwapClient({
        baseUrl: config.jupiter.baseUrl,
        apiKey: config.jupiter.apiKey,
      })
    : undefined;
  const llm = createLlmProvider(config.llm);
  const dataDir = path.resolve(config.output.dataDir);
  const blacklistStore = new BlacklistStore(
    path.join(dataDir, "token-blacklist.json"),
  );
  await blacklistStore.load();
  const poolMemoryStore = new PoolMemoryStore(
    path.join(dataDir, "pool-memory.json"),
  );
  await poolMemoryStore.load();
  return {
    meteora: base.meteora,
    jupiter: base.jupiter,
    ...(jupiterSwap ? { jupiterSwap } : {}),
    actions,
    wallet,
    llm,
    tracker,
    closedStore,
    lessonStore,
    evaluator,
    listener,
    blacklistStore,
    poolMemoryStore,
    tradeLedger,
    circuitBreaker,
  };
}

interface LearningManagerSide {
  tracker: ManagerDeps["tracker"];
  closedStore: ManagerDeps["closedStore"];
  evaluator: ManagerDeps["evaluator"];
  lessonStore: ManagerDeps["lessonStore"];
}

interface LearningDeps {
  recorder: LearningRecorder;
  ranker: ShadowRanker;
  /** Only populated when manager-side context is available. */
  collector: OutcomeCollector | null;
  /** Only populated when manager-side context is available. */
  miner: LessonMiner | null;
  snapshotEmitter: LearningSnapshotEmitter;
  signalWeightsEmitter: SignalWeightsEmitter;
}

function buildLearningDeps(
  config: UserConfig,
  base: BuiltDeps,
  managerSide?: LearningManagerSide,
): LearningDeps | null {
  if (!config.learning.enabled) return null;
  const lc = config.learning;

  const decStore = new JsonlStore<LearningDecision & Record<string, unknown>>(
    lc.files.decisions,
  );
  const outStore = new JsonlStore<LearningOutcome & Record<string, unknown>>(
    lc.files.outcomes,
  );
  const shdStore = new JsonlStore<ShadowScore & Record<string, unknown>>(
    lc.files.shadowScores,
  );
  const lesStore = new JsonlStore<LearningLesson & Record<string, unknown>>(
    lc.files.lessons,
  );

  const recorder = new LearningRecorder({
    decisionsStore: decStore,
    learningConfig: lc,
  });
  const scheduler = new OutcomeScheduler({
    decisionsStore: decStore,
    outcomesStore: outStore,
    horizons: lc.horizonsMinutes,
  });
  const entryComputer = new EntryOutcomeComputer({
    meteora: base.meteora,
    jupiter: base.jupiter,
  });

  const index = new EvidenceIndex({
    decisionsStore: decStore,
    outcomesStore: outStore,
    recencyHalfLifeDays: lc.recencyHalfLifeDays,
    horizonWeights: lc.horizonWeights,
  });
  index.build();

  const ranker = new ShadowRanker({
    index,
    shadowStore: shdStore,
    minEvidence: lc.minEvidenceForScore,
    enterThreshold: lc.shadow?.enterThreshold,
    skipThreshold: lc.shadow?.skipThreshold,
  });

  let collector: OutcomeCollector | null = null;
  let miner: LessonMiner | null = null;
  if (managerSide) {
    const realizedComputer = new RealizedOutcomeComputer({
      tracker: managerSide.tracker,
      closedStore: managerSide.closedStore,
      evaluator: managerSide.evaluator,
    });
    collector = new OutcomeCollector({
      scheduler,
      entryComputer,
      realizedComputer,
      outcomesStore: outStore,
      maxPerCycle: lc.maxOutcomesPerCycle,
    });
    miner = new LessonMiner({
      lessonStore: managerSide.lessonStore,
      evidenceLessonsStore: lesStore,
      index,
      closedStore: managerSide.closedStore,
      minCohortSamples: lc.minEvidenceForScore * 2,
      minCohortAbsAvg: 0.3,
    });
  }

  const snapshotEmitter = new LearningSnapshotEmitter({
    filePath: lc.files.snapshot,
    decisionsStore: decStore,
    outcomesStore: outStore,
    shadowStore: shdStore,
    lessonsStore: lesStore,
    index,
    horizons: lc.horizonsMinutes,
  });
  const signalWeightsEmitter = new SignalWeightsEmitter({
    filePath: lc.files.signalWeights,
    decisionsStore: decStore,
    outcomesStore: outStore,
    minSamples: lc.signalWeightMinSamples ?? lc.minEvidenceForScore,
    maxSignals: lc.signalWeightMaxSignals,
  });

  return {
    recorder,
    ranker,
    collector,
    miner,
    snapshotEmitter,
    signalWeightsEmitter,
  };
}

interface MemoryDeps {
  journal: DecisionJournal;
  router: MemoryRouter;
}

function buildMemoryDeps(
  config: UserConfig,
  onJournalEntry?: (entry: DecisionJournalEntry) => void,
): MemoryDeps | null {
  if (!config.memory.enabled) return null;
  const journal = new DecisionJournal(config.memory.journalFile);
  if (onJournalEntry) journal.onAppend(onJournalEntry);
  const learningDecisionStore = new JsonlStore<
    LearningDecision & Record<string, unknown>
  >(config.learning.files.decisions);
  const learningLessonsStore = new JsonlStore<
    LearningLesson & Record<string, unknown>
  >(config.learning.files.lessons);
  const shadowStore = new JsonlStore<ShadowScore & Record<string, unknown>>(
    config.learning.files.shadowScores,
  );
  const router = new MemoryRouter({
    config,
    journal,
    learningDecisionStore,
    learningLessonsStore,
    shadowStore,
  });
  return { journal, router };
}

function buildTelegramNotifier(
  config: UserConfig,
  memory?: MemoryDeps | null,
): TelegramNotifier | null {
  const telegramConfig = getTelegramConfigFromEnv();
  if (!telegramConfig.enabled) return null;
  if (!telegramConfig.botToken || !telegramConfig.chatId) {
    childLogger("cli").warn(
      "telegram enabled but TELEGRAM_BOT_TOKEN or CHAT_ID is missing",
    );
    return null;
  }
  return new TelegramNotifier({
    botToken: telegramConfig.botToken,
    chatId: telegramConfig.chatId,
    dryRun: config.dryRun,
    commandsFile: path.resolve(
      config.output.dataDir ?? "./data",
      "commands.jsonl",
    ),
    ...(telegramConfig.dashboardUrl
      ? { dashboardUrl: telegramConfig.dashboardUrl }
      : {}),
    ...(memory?.journal ? { journal: memory.journal } : {}),
    ...(config.manager.positionsFile
      ? { positionsFile: config.manager.positionsFile }
      : {}),
  });
}

function actionBadge(kind: ManagerActionKind): string {
  switch (kind) {
    case "hold":
      return chalk.bgGray.white.bold(" HOLD ");
    case "claim":
      return chalk.bgGreen.black.bold(" CLAIM ");
    case "close":
      return chalk.bgRed.white.bold(" CLOSE ");
    case "rebalance":
      return chalk.bgYellow.black.bold(" REBAL ");
    case "skip":
      return chalk.bgBlue.white.bold(" SKIP ");
    case "error":
      return chalk.bgMagenta.white.bold(" ERR  ");
    default:
      return chalk.gray(kind);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}

function renderManagerReport(report: ManagerCycleReport): string {
  const table = new Table({
    head: [
      chalk.cyan("Pool"),
      chalk.cyan("Position"),
      chalk.cyan("In-Range"),
      chalk.cyan("Fees"),
      chalk.cyan("PnL"),
      chalk.cyan("Action"),
      chalk.cyan("Reason"),
    ],
    colWidths: [20, 14, 11, 10, 10, 10, 36],
    wordWrap: true,
  });

  const evalByPubkey = new Map(
    report.evaluations.map((e) => [e.position.positionPubkey, e]),
  );

  for (const rec of report.actions) {
    const evaluation = evalByPubkey.get(rec.positionPubkey);
    const position = evaluation?.position;
    const inRange = evaluation
      ? `${evaluation.inRange ? chalk.green("Y") : chalk.red("N")} ${chalk.gray(
          fmtPct(evaluation.inRangePct),
        )}`
      : chalk.gray("-");
    const fees = evaluation
      ? fmtUsd(evaluation.claimableFees.usdValue) +
        (evaluation.remoteMeteoraPnl ? chalk.gray("*") : "")
      : chalk.gray("-");
    const pnl = evaluation ? colorPnl(evaluation.pnlUsd) : chalk.gray("-");
    table.push([
      position ? chalk.bold(position.poolName) : chalk.gray("-"),
      chalk.gray(shortAddr(rec.positionPubkey)),
      inRange,
      fees,
      pnl,
      actionBadge(rec.action.kind),
      truncate(rec.action.reason, 34) +
        (rec.success ? "" : chalk.red(` ! ${truncate(rec.error ?? "", 12)}`)),
    ]);
  }
  return table.toString();
}

function colorPnl(n: number): string {
  if (!Number.isFinite(n)) return chalk.gray("-");
  if (n > 0) return chalk.green(fmtUsd(n));
  if (n < 0) return chalk.red(fmtUsd(n));
  return chalk.gray(fmtUsd(n));
}

function printResults(results: ScreeningResult[]): void {
  if (results.length === 0) {
    console.log(chalk.yellow("No results from this screening cycle."));
    return;
  }
  console.log("\n" + renderResultsTable(results));
  for (const r of results) {
    if (r.decision && r.decision.action !== "SKIP") {
      console.log(renderDecisionDetail(r));
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface ScreenOpts {
  limit: string;
  dryRun?: boolean;
  llm?: boolean;
  config?: string;
}

async function screenCommand(opts: ScreenOpts, parent: Command): Promise<void> {
  applyGlobalOptions(parent.optsWithGlobals<{ verbose?: boolean }>());
  const spinner = ora();
  try {
    const base = buildDeps(opts.config);
    const { config, meteora, jupiter, okx, decisionLogger, emitters } = base;
    const memory = buildMemoryDeps(config);
    const telegram = buildTelegramNotifier(config, memory);
    if (telegram && memory) {
      memory.journal.onAppend((entry) => telegram.notifyJournalEntry(entry));
    }
    const progressSink = createProgressSink({ spinner, telegram });
    const limit = Number.parseInt(opts.limit, 10) || 100;
    const useLlm = opts.llm !== false;
    const dryRunOverride = opts.dryRun ? true : undefined;

    // When manager is enabled in config, build it so ENTER decisions
    // auto-open positions (honors config.dryRun — no live tx in dry-run).
    let manager: ManagerAgent | undefined;
    let learning: LearningDeps | null = null;
    if (config.manager.enabled) {
      const managerDeps = await buildManagerDeps(config, base);
      learning = buildLearningDeps(config, base, {
        tracker: managerDeps.tracker,
        closedStore: managerDeps.closedStore,
        evaluator: managerDeps.evaluator,
        lessonStore: managerDeps.lessonStore,
      });
      manager = new ManagerAgent(config, {
        ...managerDeps,
        progressEmitter: emitters.progress,
        onProgress: progressSink,
        ...(learning?.recorder ? { learningRecorder: learning.recorder } : {}),
        ...(learning?.collector
          ? { outcomeCollector: learning.collector }
          : {}),
        ...(learning?.miner ? { lessonMiner: learning.miner } : {}),
        ...(learning?.snapshotEmitter
          ? { snapshotEmitter: learning.snapshotEmitter }
          : {}),
        ...(learning?.signalWeightsEmitter
          ? { signalWeightsEmitter: learning.signalWeightsEmitter }
          : {}),
        ...(memory?.journal ? { decisionJournal: memory.journal } : {}),
        ...(memory?.router ? { memoryRouter: memory.router } : {}),
      });
      if (config.dryRun) {
        console.log(
          chalk.bgYellow.black.bold(" DRY-RUN ") +
            chalk.yellow(" auto-open from ENTER decisions will only simulate."),
        );
      }
    } else {
      learning = buildLearningDeps(config, base);
    }

    spinner.start("Running screening cycle…");
    const screener = new ScreenerAgent(config, {
      meteora,
      jupiter,
      okx,
      decisionLogger,
      manager,
      candidatesEmitter: emitters.candidates,
      llmRunsEmitter: emitters.llmRuns,
      progressEmitter: emitters.progress,
      commandEmitter: emitters.commands,
      onProgress: progressSink,
      ...(learning?.recorder ? { learningRecorder: learning.recorder } : {}),
      ...(learning?.ranker ? { shadowRanker: learning.ranker } : {}),
      ...(memory?.journal ? { decisionJournal: memory.journal } : {}),
      ...(memory?.router ? { memoryRouter: memory.router } : {}),
    });
    const results = await screener.runOnce({ limit, useLlm, dryRunOverride });
    spinner.succeed(`Screening complete: ${results.length} pool(s) evaluated.`);

    printResults(results);
    if (telegram) await telegram.flush();
    process.exit(0);
  } catch (err) {
    spinner.fail("Screening failed.");
    fatal(err);
  }
}

interface StartOpts {
  realtime?: boolean;
  cron?: boolean;
  manager?: boolean;
  config?: string;
}

async function startCommand(opts: StartOpts, parent: Command): Promise<void> {
  applyGlobalOptions(parent.optsWithGlobals<{ verbose?: boolean }>());
  const spinner = ora();
  try {
    const base = buildDeps(opts.config);
    const { config, meteora, jupiter, okx, decisionLogger, emitters } = base;
    const memory = buildMemoryDeps(config);
    const telegram = buildTelegramNotifier(config, memory);
    if (telegram && memory) {
      memory.journal.onAppend((entry) => telegram.notifyJournalEntry(entry));
    }
    const progressSink = createProgressSink({ telegram });

    let listener: RealtimeListener | undefined;
    if (opts.realtime !== false) {
      spinner.start("Connecting realtime WebSocket listener…");
      listener = new RealtimeListener(
        config,
        (event: RealtimeEvent) => {
          logger.debug({ event }, "realtime");
          // Real-time rebalance trigger: fire-and-forget
          if (manager && event.poolAddress) {
            manager.handleRealtimeEvent(event).catch(() => {});
          }
        },
        { signalSnapshotStore: base.signalSnapshot },
      );
      await listener.start();
      spinner.succeed("Realtime listener connected.");
    } else {
      console.log(chalk.gray("Realtime listener disabled (--no-realtime)."));
    }

    // ----- Manager (built BEFORE screener so screener can auto-open ENTER decisions) -----
    const managerEnabled = opts.manager !== false && config.manager.enabled;
    let manager: ManagerAgent | null = null;
    let managerDeps: ManagerDeps | null = null;
    if (managerEnabled) {
      console.log(
        chalk.cyan(
          `Starting Manager agent (cron: "${config.manager.cron}", useLlm=${config.manager.useLlm}, dryRun=${config.dryRun})`,
        ),
      );
      if (config.dryRun) {
        console.log(
          chalk.bgYellow.black.bold(" DRY-RUN ") +
            chalk.yellow(" no live transactions will be signed."),
        );
      }
      managerDeps = await buildManagerDeps(config, base, listener);
      const learningForStart = buildLearningDeps(config, base, {
        tracker: managerDeps.tracker,
        closedStore: managerDeps.closedStore,
        evaluator: managerDeps.evaluator,
        lessonStore: managerDeps.lessonStore,
      });
      manager = new ManagerAgent(config, {
        ...managerDeps,
        progressEmitter: emitters.progress,
        onProgress: progressSink,
        ...(learningForStart?.recorder
          ? { learningRecorder: learningForStart.recorder }
          : {}),
        ...(learningForStart?.collector
          ? { outcomeCollector: learningForStart.collector }
          : {}),
        ...(learningForStart?.miner
          ? { lessonMiner: learningForStart.miner }
          : {}),
        ...(learningForStart?.snapshotEmitter
          ? { snapshotEmitter: learningForStart.snapshotEmitter }
          : {}),
        ...(learningForStart?.signalWeightsEmitter
          ? { signalWeightsEmitter: learningForStart.signalWeightsEmitter }
          : {}),
        ...(memory?.journal ? { decisionJournal: memory.journal } : {}),
        ...(memory?.router ? { memoryRouter: memory.router } : {}),
      });
      // Stash on managerDeps via assignment for later screener wiring.
      (
        managerDeps as ManagerDeps & { _learning?: LearningDeps | null }
      )._learning = learningForStart;

      // AUTO-CLEANUP empty positions from prior runs (phantom positions
      // where tx#1 succeeded but tx#2 failed). Reclaims ~0.057 SOL rent
      // per position. Skipped when manager.autoCleanupEmpty=false.
      if (config.manager.autoCleanupEmpty !== false) {
        spinner.start("Scanning for phantom (empty) positions…");
        try {
          const cleanupRunner = new CleanupRunner({
            tracker: managerDeps.tracker,
            actions: managerDeps.actions,
            dryRun: config.dryRun,
          });
          const report = await cleanupRunner.runOnce();
          if (report.emptyFound === 0) {
            spinner.succeed("No phantom positions found.");
          } else if (report.closed.length === report.emptyFound) {
            spinner.succeed(
              `Auto-cleaned ${report.closed.length}/${report.emptyFound} phantom(s), reclaimed ~${report.totalReclaimedSol.toFixed(4)} SOL`,
            );
          } else {
            spinner.warn(
              `Auto-cleanup partial: ${report.closed.length}/${report.emptyFound} closed (${report.failed.length} failed — left in tracker for retry)`,
            );
          }
        } catch (err) {
          spinner.fail(`Auto-cleanup failed: ${getErrorMessage(err)}`);
        }
      }

      // CAPITAL REBALANCE — at startup, swap SOL ↔ USDC to maintain the
      // target split so LP positions can actually be funded. Skipped when
      // capital.enabled=false. Honors config.dryRun.
      if (config.capital.enabled) {
        spinner.start(
          `Capital balance check (target ${(config.capital.targetUsdcFraction * 100).toFixed(0)}% USDC)…`,
        );
        const capitalConnection = createConnection(
          config.rpc.url,
          config.rpc.commitment,
        );
        const capitalWallet = new WalletTools({
          connection: capitalConnection,
          privateKeyBase58: getWalletPrivateKey(),
        });
        const jupiterSwap = new JupiterSwapClient({
          baseUrl: config.jupiter.baseUrl,
          apiKey: config.jupiter.apiKey,
        });
        const capitalManager = new CapitalManager({
          config: config.capital,
          connection: capitalConnection,
          wallet: capitalWallet,
          jupiter: base.jupiter,
          jupiterSwap,
          dryRun: config.dryRun,
        });
        try {
          const result = await capitalManager.ensureBalance();
          if (result.action === "none") {
            spinner.succeed(`Capital balanced — ${result.reason}`);
          } else {
            const inMint = result.swapInputMint?.slice(0, 8) ?? "?";
            const outMint = result.swapOutputMint?.slice(0, 8) ?? "?";
            spinner.succeed(
              `Capital ${result.action}: ${inMint}… → ${outMint}…  ${result.signature ? chalk.gray("sig=" + result.signature.slice(0, 16) + "…") : ""}`,
            );
          }
        } catch (err) {
          spinner.fail(`Capital check failed: ${getErrorMessage(err)}`);
        }
      } else {
        console.log(
          chalk.gray("Capital management disabled (capital.enabled=false)."),
        );
      }
    } else if (opts.manager === false) {
      console.log(chalk.gray("Manager disabled (--no-manager)."));
    } else {
      console.log(
        chalk.gray("Manager disabled in config (manager.enabled=false)."),
      );
    }

    // Reuse the learning deps built alongside manager when present; otherwise
    // build a screener-only learning bundle so shadow scoring still runs.
    const screenerLearning: LearningDeps | null =
      (
        managerDeps as
          | (ManagerDeps & { _learning?: LearningDeps | null })
          | null
      )?._learning ?? buildLearningDeps(config, base);
    const screener = new ScreenerAgent(config, {
      meteora,
      jupiter,
      okx,
      decisionLogger,
      listener,
      manager: manager ?? undefined,
      candidatesEmitter: emitters.candidates,
      llmRunsEmitter: emitters.llmRuns,
      progressEmitter: emitters.progress,
      commandEmitter: emitters.commands,
      onProgress: progressSink,
      onCycleComplete: printResults,
      ...(screenerLearning?.recorder
        ? { learningRecorder: screenerLearning.recorder }
        : {}),
      ...(screenerLearning?.ranker
        ? { shadowRanker: screenerLearning.ranker }
        : {}),
      ...(memory?.journal ? { decisionJournal: memory.journal } : {}),
      ...(memory?.router ? { memoryRouter: memory.router } : {}),
    });

    const cronEnabled = opts.cron !== false && config.scheduler.enabled;
    if (cronEnabled) {
      console.log(
        chalk.cyan(
          `Autonomous scheduler enabled (cron: "${config.scheduler.screenCron}")`,
        ),
      );

      // Run an immediate cycle (which will auto-open any ENTER decisions
      // through `screener.deps.manager` if the manager is enabled).
      spinner.start("Running initial screening cycle…");
      const results = await screener.runOnce();
      spinner.succeed(
        `Initial cycle complete: ${results.length} pool(s) evaluated.`,
      );
      printResults(results);
      console.log(
        chalk.cyan(
          `Starting autonomous scheduler (cron: "${config.scheduler.screenCron}")`,
        ),
      );
      screener.startAuto();
    } else if (opts.cron === false) {
      console.log(chalk.gray("Scheduler disabled (--no-cron)."));
    } else {
      console.log(
        chalk.gray("Scheduler disabled in config (scheduler.enabled=false)."),
      );
    }

    // Start Manager cron AFTER the initial screening cycle so any auto-opened
    // positions are picked up on the first manager tick.
    if (manager) {
      manager.startAuto();
    }

    // ----- Hot-reload watcher for user-config.json -----
    const cliLog = childLogger("cli");
    const watcher = new ConfigWatcher({
      configPath: opts.config ?? configPath(),
      onReload: (next): void => {
        screener.updateMutableConfig(next);
        if (manager) manager.updateMutableConfig(next);
      },
    });
    watcher.start();

    // ----- Append-only command consumer (data/commands.jsonl) -----
    const cmdsFile = path.resolve(
      config.output.dataDir ?? "./data",
      "commands.jsonl",
    );
    const consumer = new CommandConsumer({
      filePath: cmdsFile,
      onCommand: async (cmd: BotCommand): Promise<void> => {
        try {
          switch (cmd.kind) {
            case "screen": {
              const limitArg = cmd.args?.limit;
              const limit =
                typeof limitArg === "number" && Number.isFinite(limitArg)
                  ? limitArg
                  : Number(limitArg) || 50;
              const results = await screener.runOnce({
                limit,
                commandId: cmd.id,
              });
              cliLog.info(
                { cmdId: cmd.id, results: results.length },
                "screen command done",
              );
              break;
            }
            case "manage": {
              if (!manager) {
                cliLog.warn(
                  { cmdId: cmd.id },
                  "manage command ignored: manager disabled",
                );
                return;
              }
              const report = await manager.runOnce({ commandId: cmd.id });
              cliLog.info(
                { cmdId: cmd.id, actions: report.actions.length },
                "manage command done",
              );
              break;
            }
            case "open": {
              if (!manager) {
                cliLog.info(
                  { cmdId: cmd.id },
                  "open command left for manager process",
                );
                return;
              }
              const args = cmd.args ?? {};
              const poolAddress = String(args.poolAddress ?? "");
              if (!poolAddress) {
                cliLog.warn(
                  { cmdId: cmd.id },
                  "open command missing poolAddress",
                );
                return;
              }
              const cycleId =
                typeof args.cycleId === "string"
                  ? args.cycleId
                  : typeof args.cycleIdOnEnter === "string"
                    ? args.cycleIdOnEnter
                    : undefined;
              const openInput: OpenPositionInput = {
                poolAddress,
                sizeUsd: Number(args.sizeUsd ?? 50),
                rangeBps: Number(args.rangeBps ?? 1500),
                dryRun:
                  typeof args.dryRun === "boolean"
                    ? args.dryRun
                    : config.dryRun,
                paper: args.paper === true,
                ...(cycleId ? { cycleIdOnEnter: cycleId } : {}),
                ...(isObjectRecord(args.entrySnapshot)
                  ? {
                      entrySnapshot:
                        args.entrySnapshot as unknown as EntrySnapshot,
                    }
                  : {}),
                ...(typeof args.notes === "string"
                  ? { notes: args.notes }
                  : {}),
              };
              const opened = openInput.paper
                ? await manager.openPaper(
                    openInput,
                    cycleId ? { cycleId } : undefined,
                  )
                : await manager.open(
                    openInput,
                    cycleId ? { cycleId } : undefined,
                  );
              cliLog.info(
                { cmdId: cmd.id, opened: !!opened },
                "open command done",
              );
              break;
            }
            case "close": {
              if (!manager) {
                cliLog.warn(
                  { cmdId: cmd.id },
                  "close command ignored: manager disabled",
                );
                return;
              }
              const pubkey = String(cmd.args?.positionPubkey ?? "");
              const reason =
                typeof cmd.args?.reason === "string"
                  ? cmd.args.reason
                  : "manual close";
              const r = await manager.closeTrackedPosition(pubkey, reason, {
                commandId: cmd.id,
              });
              cliLog.info(
                {
                  cmdId: cmd.id,
                  sig: r.signature,
                  success: r.success,
                  error: r.error,
                },
                "close command done",
              );
              break;
            }
            case "claim": {
              if (!managerDeps) {
                cliLog.warn(
                  { cmdId: cmd.id },
                  "claim command ignored: manager disabled",
                );
                return;
              }
              const pubkey = String(cmd.args?.positionPubkey ?? "");
              const tracked = managerDeps.tracker.get(pubkey);
              const r = await managerDeps.actions.claimFees({
                positionPubkey: pubkey,
                poolAddress: tracked?.poolAddress,
                dryRun: config.dryRun,
              });
              cliLog.info(
                { cmdId: cmd.id, sig: r.signature },
                "claim command done",
              );
              break;
            }
            default: {
              const _exhaustive: never = cmd.kind;
              cliLog.warn(
                { cmdId: cmd.id, kind: String(_exhaustive) },
                "unknown command kind",
              );
            }
          }
        } catch (err) {
          cliLog.warn(
            { err, cmdId: cmd.id, kind: cmd.kind },
            "command execution failed",
          );
        }
      },
    });
    consumer.start();
    const ownsTelegramPolling = managerEnabled || !config.manager.enabled;
    if (telegram && ownsTelegramPolling) {
      telegram.startPolling();
      await telegram.sendControlCenter();
      console.log(chalk.cyan("Telegram control center enabled."));
    } else if (telegram) {
      cliLog.info(
        "telegram polling disabled in screener-only process; manager daemon owns getUpdates",
      );
    }

    // --- Heartbeat + cron-stall watchdog ---
    // Logs basic counts every 60s. If a cron has been silent for >2.5× its
    // interval, logs WARN and re-registers the cron (stop+start). This catches
    // silent stalls (e.g. node-cron freezing after Windows sleep/wake).
    // Thresholds at 2.5× interval: manager cron */5 → 12.5min, screener */15 → 37.5min.
    const HEARTBEAT_MS = 60_000;
    const STALL_FACTOR = 2.5;
    const hbLog = childLogger("heartbeat");

    const parseEveryNMin = (expr: string): number | null => {
      const m = expr.trim().match(/^\*\/(\d+) \* \* \* \*$/);
      return m ? Number(m[1]) : null;
    };

    const heartbeatTimer = setInterval(() => {
      try {
        const learningCfg = config.learning;
        let dec = 0;
        let out = 0;
        let les = 0;
        const safeCount = (p: string): number => {
          try {
            const raw = fs.readFileSync(p, "utf-8");
            return raw.split("\n").filter((l) => l.trim().length > 0).length;
          } catch {
            return 0;
          }
        };
        try {
          dec = safeCount(learningCfg.files.decisions);
          out = safeCount(learningCfg.files.outcomes);
          les = safeCount(learningCfg.files.lessons);
        } catch {
          // best-effort
        }

        const now = Date.now();
        const screenerLast = screener.getLastCycleAt();
        const managerLast = manager ? manager.getLastCycleAt() : null;
        const screenerSilentMs = screenerLast ? now - screenerLast : null;
        const managerSilentMs = managerLast ? now - managerLast : null;

        hbLog.info(
          {
            pid: process.pid,
            decisions: dec,
            outcomes: out,
            lessons: les,
            screenerSilentMs,
            managerSilentMs,
          },
          "heartbeat",
        );

        const screenerEveryMin = parseEveryNMin(screener.getCronExpression());
        if (screenerEveryMin && screenerLast && screener.isCronRunning()) {
          const stallThresholdMs = screenerEveryMin * 60_000 * STALL_FACTOR;
          if (
            screenerSilentMs !== null &&
            screenerSilentMs > stallThresholdMs
          ) {
            hbLog.warn(
              {
                silentMs: screenerSilentMs,
                thresholdMs: stallThresholdMs,
                expr: screener.getCronExpression(),
              },
              "screener cron stalled — re-registering",
            );
            try {
              screener.stopAuto();
              screener.startAuto();
            } catch (err) {
              hbLog.error({ err }, "screener cron re-register failed");
            }
          }
        }

        if (manager) {
          const managerEveryMin = parseEveryNMin(manager.getCronExpression());
          if (managerEveryMin && managerLast && manager.isCronRunning()) {
            const stallThresholdMs = managerEveryMin * 60_000 * STALL_FACTOR;
            if (
              managerSilentMs !== null &&
              managerSilentMs > stallThresholdMs
            ) {
              hbLog.warn(
                {
                  silentMs: managerSilentMs,
                  thresholdMs: stallThresholdMs,
                  expr: manager.getCronExpression(),
                },
                "manager cron stalled — re-registering",
              );
              try {
                manager.stopAuto();
                manager.startAuto();
              } catch (err) {
                hbLog.error({ err }, "manager cron re-register failed");
              }
            }
          }
        }
      } catch {
        // Heartbeat must never crash the bot.
      }
    }, HEARTBEAT_MS);

    // ── LPAgent PnL polling (only when positions are open) ───────────
    let pnlPollTimer: ReturnType<typeof setInterval> | undefined;
    if (base.lpagent && managerDeps?.wallet) {
      const pnlLog = childLogger("lpagent-pnl");
      const owner = managerDeps.wallet.getPublicKey().toBase58();
      const pollMs = config.lpagent?.pollIntervalMs ?? 10_000;

      const pollPnl = async () => {
        const posCount = managerDeps!.tracker.count();
        pnlLog.debug({ posCount }, "pnl poll tick");
        // Skip entirely when no open positions
        if (posCount === 0) return;

        try {
          const [overview, opening] = await Promise.all([
            base.lpagent!.getOverview(owner),
            base.lpagent!.getOpening(owner),
          ]);

          if (opening.length > 0 && telegram) {
            const lines = opening.map((pos) => {
              const sign = pos.pnlUsd >= 0 ? "+" : "";
              const range = pos.inRange ? "✅" : "❌";
              return `${range} ${pos.poolName || pos.poolAddress.slice(0, 8)} | PnL: ${sign}$${pos.pnlUsd.toFixed(2)} | Fees: $${pos.feeEarnedUsd.toFixed(2)} | APR: ${(pos.apr * 100).toFixed(0)}%`;
            });
            const totalPnl = opening.reduce((s, p) => s + p.pnlUsd, 0);
            const totalSign = totalPnl >= 0 ? "+" : "";
            telegram.notifyProgress({
              id: `lpagent-pnl-${Date.now()}`,
              cycleId: "lpagent-poll",
              source: "MANAGER",
              phase: "pnl",
              status: "success",
              percent: 100,
              message: `📊 Open Positions (${opening.length}):\n${lines.join("\n")}\n\nTotal PnL: ${totalSign}$${totalPnl.toFixed(2)}`,
              startedAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        } catch (err) {
          pnlLog.debug(
            { err: err instanceof Error ? err.message : String(err) },
            "pnl poll failed",
          );
        }
      };

      pnlPollTimer = setInterval(() => void pollPnl(), pollMs);
    }

    const shutdown = async (signal: string): Promise<void> => {
      console.log("\n" + chalk.cyan(`Shutting down… (signal=${signal})`));
      try {
        clearInterval(heartbeatTimer);
        if (pnlPollTimer) clearInterval(pnlPollTimer);
        watcher.stop();
        consumer.stop();
        if (telegram) telegram.stopPolling();
        if (cronEnabled) screener.stopAuto();
        if (manager) manager.stopAuto();
        if (listener) await listener.stop();
      } catch (err) {
        logger.error({ err }, "error during shutdown");
      }
      process.exit(0);
    };
    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    console.log(chalk.gray("Press Ctrl+C to stop."));
    // Keep alive — cron + ws hold the process. Nothing else to do here.
  } catch (err) {
    spinner.fail("Failed to start.");
    fatal(err);
  }
}

interface ManageOpts {
  once?: boolean;
  config?: string;
}

async function manageCommand(opts: ManageOpts, parent: Command): Promise<void> {
  applyGlobalOptions(parent.optsWithGlobals<{ verbose?: boolean }>());
  const spinner = ora();
  try {
    const base = buildDeps(opts.config);
    const { config } = base;
    const memory = buildMemoryDeps(config);
    const telegram = buildTelegramNotifier(config, memory);
    if (telegram && memory) {
      memory.journal.onAppend((entry) => telegram.notifyJournalEntry(entry));
    }
    const progressSink = createProgressSink({ spinner, telegram });
    if (config.dryRun) {
      console.log(
        chalk.bgYellow.black.bold(" DRY-RUN ") +
          chalk.yellow(" no live transactions will be signed."),
      );
    }

    const managerDeps = await buildManagerDeps(config, base);
    const learning = buildLearningDeps(config, base, {
      tracker: managerDeps.tracker,
      closedStore: managerDeps.closedStore,
      evaluator: managerDeps.evaluator,
      lessonStore: managerDeps.lessonStore,
    });
    const manager = new ManagerAgent(config, {
      ...managerDeps,
      progressEmitter: base.emitters.progress,
      onProgress: progressSink,
      ...(learning?.recorder ? { learningRecorder: learning.recorder } : {}),
      ...(learning?.collector ? { outcomeCollector: learning.collector } : {}),
      ...(learning?.miner ? { lessonMiner: learning.miner } : {}),
      ...(learning?.snapshotEmitter
        ? { snapshotEmitter: learning.snapshotEmitter }
        : {}),
      ...(learning?.signalWeightsEmitter
        ? { signalWeightsEmitter: learning.signalWeightsEmitter }
        : {}),
      ...(memory?.journal ? { decisionJournal: memory.journal } : {}),
      ...(memory?.router ? { memoryRouter: memory.router } : {}),
    });

    spinner.start("Running manager cycle…");
    const report = await manager.runOnce();
    spinner.succeed(
      `Manager cycle complete: ${report.actions.length} position(s) processed.`,
    );

    if (report.actions.length === 0) {
      console.log(chalk.yellow("No open positions to manage."));
    } else {
      console.log("\n" + renderManagerReport(report));
      console.log(
        chalk.gray(
          `\nClosed: ${report.closedCount}   Claimed: ${report.claimedCount}   Rebalanced: ${report.rebalancedCount}   Lessons: ${report.lessonsLearned}`,
        ),
      );
    }
    if (telegram) await telegram.flush();
    process.exit(0);
  } catch (err) {
    spinner.fail("Manager cycle failed.");
    fatal(err);
  }
}

interface CloseOpts {
  position: string;
  reason?: string;
  dryRun?: boolean;
  config?: string;
}

async function closeCommand(opts: CloseOpts, parent: Command): Promise<void> {
  applyGlobalOptions(parent.optsWithGlobals<{ verbose?: boolean }>());
  const spinner = ora();
  try {
    const base = buildDeps(opts.config);
    const effectiveConfig: UserConfig = opts.dryRun
      ? { ...base.config, dryRun: true }
      : base.config;
    const memory = buildMemoryDeps(effectiveConfig);
    const telegram = buildTelegramNotifier(effectiveConfig, memory);
    if (telegram && memory) {
      memory.journal.onAppend((entry) => telegram.notifyJournalEntry(entry));
    }
    const progressSink = createProgressSink({ spinner, telegram });

    if (effectiveConfig.dryRun) {
      console.log(
        chalk.bgYellow.black.bold(" DRY-RUN ") +
          chalk.yellow(" no live transactions will be signed."),
      );
    }

    const managerDeps = await buildManagerDeps(effectiveConfig, base);
    const tracked = managerDeps.tracker.get(opts.position);

    if (tracked) {
      const learning = buildLearningDeps(effectiveConfig, base, {
        tracker: managerDeps.tracker,
        closedStore: managerDeps.closedStore,
        evaluator: managerDeps.evaluator,
        lessonStore: managerDeps.lessonStore,
      });
      const manager = new ManagerAgent(effectiveConfig, {
        ...managerDeps,
        progressEmitter: base.emitters.progress,
        onProgress: progressSink,
        ...(learning?.recorder ? { learningRecorder: learning.recorder } : {}),
        ...(learning?.collector
          ? { outcomeCollector: learning.collector }
          : {}),
        ...(learning?.miner ? { lessonMiner: learning.miner } : {}),
        ...(learning?.snapshotEmitter
          ? { snapshotEmitter: learning.snapshotEmitter }
          : {}),
        ...(learning?.signalWeightsEmitter
          ? { signalWeightsEmitter: learning.signalWeightsEmitter }
          : {}),
        ...(memory?.journal ? { decisionJournal: memory.journal } : {}),
        ...(memory?.router ? { memoryRouter: memory.router } : {}),
      });

      spinner.start(`Closing tracked position ${shortAddr(opts.position)}...`);
      const result = await manager.closeTrackedPosition(
        opts.position,
        opts.reason ?? "manual close",
      );
      if (!result.success) {
        spinner.fail(`Close failed: ${result.error ?? "unknown error"}`);
        if (telegram) await telegram.flush();
        process.exit(1);
      }
      spinner.succeed(
        effectiveConfig.dryRun && !tracked.dryRun
          ? `Close simulated for ${shortAddr(opts.position)}; tracker left unchanged.`
          : `Closed ${shortAddr(opts.position)}${result.signature ? ` sig=${result.signature}` : ""}`,
      );
    } else {
      console.log(
        chalk.yellow(
          "Position is not in the tracker; closing on-chain only, without writing a closed-position record.",
        ),
      );
      spinner.start(`Closing position ${shortAddr(opts.position)}...`);
      const result = await managerDeps.actions.closePosition({
        positionPubkey: opts.position,
        dryRun: effectiveConfig.dryRun,
      });
      spinner.succeed(
        `Close ${effectiveConfig.dryRun ? "simulated" : "submitted"} for ${shortAddr(opts.position)}${result.signature ? ` sig=${result.signature}` : ""}`,
      );
    }

    if (telegram) await telegram.flush();
    process.exit(0);
  } catch (err) {
    spinner.fail("Close failed.");
    fatal(err);
  }
}

interface WalletOpts {
  config?: string;
}

async function walletCommand(opts: WalletOpts, parent: Command): Promise<void> {
  applyGlobalOptions(parent.optsWithGlobals<{ verbose?: boolean }>());
  try {
    const config = loadConfig(opts.config);
    const rpcUrl = maskApiKeyInUrl(config.rpc.url);
    console.log(chalk.bold("\nBot wallet"));
    console.log(chalk.gray(`  RPC: ${rpcUrl}`));

    const privateKey = getWalletPrivateKey();
    if (!privateKey) {
      console.log(
        chalk.yellow(
          "  Not configured. Set WALLET_PRIVATE_KEY in .env (or PRIVATE_KEY_BOT for legacy installs; run: tsx src/scripts/gen-keypair.ts to generate one).",
        ),
      );
      process.exit(0);
    }

    const connection = createConnection(config.rpc.url, config.rpc.commitment);
    const wallet = new WalletTools({
      connection,
      privateKeyBase58: privateKey,
    });
    if (!wallet.isConfigured()) {
      console.log(
        chalk.red("  Wallet present in env but failed to initialize."),
      );
      process.exit(1);
    }
    const pubkey = wallet.getPublicKey().toBase58();
    console.log(chalk.gray(`  Pubkey: ${pubkey}`));
    try {
      const sol = await wallet.getBalanceSol();
      console.log(chalk.gray(`  Balance: ${sol.toFixed(4)} SOL`));
    } catch (err) {
      console.log(
        chalk.yellow(
          `  Balance: <unavailable> (${err instanceof Error ? err.message : String(err)})`,
        ),
      );
    }
    process.exit(0);
  } catch (err) {
    fatal(err);
  }
}

interface RealtimeOpts {
  config?: string;
}

function formatRealtimeEvent(event: RealtimeEvent): string {
  const ts = new Date(event.timestamp).toISOString().slice(11, 19);
  const pool = shortAddr(event.poolAddress);
  const sig = shortAddr(event.signature);
  const amount = event.amountUsd !== undefined ? fmtUsd(event.amountUsd) : "-";

  const kindColored = ((): string => {
    switch (event.kind) {
      case "swap":
        return chalk.green(event.kind);
      case "liquidity_add":
      case "liquidity_remove":
        return chalk.yellow(event.kind);
      case "new_pool":
        return chalk.magenta(event.kind);
      case "volume_spike":
      case "active_bin_change":
        return chalk.cyan(event.kind);
      default:
        return chalk.gray(event.kind);
    }
  })();

  return `[${chalk.gray(ts)}] kind=${kindColored} pool=${pool} sig=${sig} amountUsd=${amount}`;
}

async function realtimeCommand(
  opts: RealtimeOpts,
  parent: Command,
): Promise<void> {
  applyGlobalOptions(parent.optsWithGlobals<{ verbose?: boolean }>());
  const spinner = ora();
  try {
    const base = buildDeps(opts.config);
    const { config, emitters } = base;
    console.log(chalk.bold("\nMeteora Realtime Listener"));
    console.log(chalk.gray(`  programId: ${config.meteora.programId}`));
    console.log(
      chalk.gray(`  ws url:    ${maskApiKeyInUrl(config.rpc.wsUrl)}`),
    );
    console.log("");

    spinner.start("Connecting WebSocket…");
    const listener = new RealtimeListener(
      config,
      (event: RealtimeEvent) => {
        console.log(formatRealtimeEvent(event));
      },
      { signalSnapshotStore: base.signalSnapshot },
    );
    await listener.start();
    spinner.succeed("Connected. Streaming events…");

    const shutdown = async (signal: string): Promise<void> => {
      console.log("\n" + chalk.cyan(`Shutting down… (signal=${signal})`));
      try {
        await listener.stop();
      } catch (err) {
        logger.error({ err }, "error during shutdown");
      }
      process.exit(0);
    };
    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    console.log(chalk.gray("Press Ctrl+C to stop.\n"));
  } catch (err) {
    spinner.fail("Realtime listener failed.");
    fatal(err);
  }
}

interface CandidatesOpts {
  limit: string;
  config?: string;
}

async function candidatesCommand(
  opts: CandidatesOpts,
  parent: Command,
): Promise<void> {
  applyGlobalOptions(parent.optsWithGlobals<{ verbose?: boolean }>());
  const spinner = ora();
  try {
    const { config, meteora } = buildDeps(opts.config);
    const limit = Number.parseInt(opts.limit, 10) || 20;

    spinner.start(
      `Fetching top ${limit} Meteora pools (${config.meteora.timeframe}/${config.meteora.category})…`,
    );
    const pairs = await meteora.fetchAllPairs({
      limit,
      sortBy: "fees_24h",
      filters: config.filters,
    });
    spinner.succeed(`Fetched ${pairs.length} candidate pool(s).`);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TableMod = await import("cli-table3");
    const Table = TableMod.default;

    const table = new Table({
      head: [
        chalk.cyan("Pool"),
        chalk.cyan("Address"),
        chalk.cyan("Bin"),
        chalk.cyan("TVL"),
        chalk.cyan("Vol"),
        chalk.cyan("Fees"),
      ],
      colWidths: [22, 14, 6, 12, 12, 12],
      wordWrap: true,
    });

    for (const p of pairs) {
      table.push([
        chalk.bold(p.name),
        chalk.gray(shortAddr(p.address)),
        String(p.binStep),
        fmtUsd(p.tvl),
        fmtUsd(p.volume24h),
        fmtUsd(p.fees24h),
      ]);
    }

    console.log("\n" + table.toString());
    process.exit(0);
  } catch (err) {
    spinner.fail("Failed to fetch candidates.");
    fatal(err);
  }
}

interface ConfigOpts {
  show?: boolean;
  path?: boolean;
  config?: string;
}

function configCommand(opts: ConfigOpts, parent: Command): void {
  applyGlobalOptions(parent.optsWithGlobals<{ verbose?: boolean }>());
  try {
    if (opts.path) {
      console.log(configPath());
      return;
    }
    const cfg = loadConfig(opts.config);
    const masked = maskConfig(cfg);
    console.log(chalk.bold("\nResolved config:"));
    console.log(chalk.gray(`(source: ${opts.config ?? configPath()})\n`));
    console.log(JSON.stringify(masked, null, 2));
  } catch (err) {
    fatal(err);
  }
}

// ---------------------------------------------------------------------------
// Process-wide error handlers
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (reason: unknown) => {
  logger.error({ reason }, "unhandledRejection");
  console.error(chalk.red(`✗ Unhandled rejection: ${getErrorMessage(reason)}`));
  process.exit(1);
});

process.on("uncaughtException", (err: Error) => {
  logger.error({ err }, "uncaughtException");
  console.error(chalk.red(`✗ Uncaught exception: ${err.message}`));
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Command tree
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("meteora-screener")
  .description("Autonomous CLI agent for screening Meteora DLMM pools.")
  .version(readPackageVersion(), "-V, --version", "output the version number")
  .option("--verbose", "enable verbose (debug) logging", false);

program
  .command("screen")
  .description("Run a single screening cycle and print a table")
  .option("--limit <n>", "maximum pools to fetch from Meteora", "100")
  .option("--dry-run", "force dry-run mode (no live actions)", false)
  .option("--no-llm", "skip LLM reasoning step (hard filters only)")
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: ScreenOpts, cmd: Command) => {
    await screenCommand(opts, cmd);
  });

program
  .command("start")
  .description(
    "Run autonomous mode: cron screening + realtime WS + Manager agent",
  )
  .option("--no-realtime", "disable the realtime WebSocket listener")
  .option("--no-cron", "disable the cron scheduler")
  .option("--no-manager", "disable the Manager agent")
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: StartOpts, cmd: Command) => {
    await startCommand(opts, cmd);
  });

program
  .command("manage")
  .description("Run a single Manager cycle over open positions")
  .option("--once", "run one cycle and exit (default behavior)", true)
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: ManageOpts, cmd: Command) => {
    await manageCommand(opts, cmd);
  });

program
  .command("close")
  .description("Close a Meteora DLMM position")
  .requiredOption("--position <pubkey>", "position public key")
  .option("--reason <text>", "close reason", "manual close")
  .option("--dry-run", "simulate close without signing", false)
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: CloseOpts, cmd: Command) => {
    await closeCommand(opts, cmd);
  });

program
  .command("wallet")
  .description("Show bot wallet pubkey + SOL balance")
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: WalletOpts, cmd: Command) => {
    await walletCommand(opts, cmd);
  });

program
  .command("lpnl")
  .description("Show LP PnL from LPAgent (overview + open positions)")
  .option("--config <path>", "path to user-config.json")
  .option(
    "--poll <seconds>",
    "poll continuously every N seconds (0 = one-shot)",
    "0",
  )
  .action(
    async (opts: { config?: string; poll?: string }, cmd: Command) => {
      applyGlobalOptions(cmd.optsWithGlobals<{ verbose?: boolean }>());
      try {
        const base = buildDeps(opts.config);
        if (!base.lpagent) {
          console.error(
            chalk.red(
              "LPAgent not configured. Set LPAGENT_API_KEY in .env and lpagent.enabled=true in config.",
            ),
          );
          process.exit(1);
        }

        const connection = createConnection(
          base.config.rpc.url,
          base.config.rpc.commitment,
        );
        const wallet = new WalletTools({
          connection,
          privateKeyBase58: getWalletPrivateKey(),
        });
        if (!wallet.isConfigured()) {
          console.error(
            chalk.red("Wallet not configured. Set WALLET_PRIVATE_KEY in .env."),
          );
          process.exit(1);
        }
        const owner = wallet.getPublicKey().toBase58();
        console.log(chalk.bold(`\nWallet: ${owner}\n`));

        const pollSeconds = Number(opts.poll ?? "0");

        const printPnl = async () => {
          const [overview, opening] = await Promise.all([
            base.lpagent!.getOverview(owner),
            base.lpagent!.getOpening(owner),
          ]);

          if (!overview) {
            console.log(chalk.yellow("No LPAgent data available for this wallet."));
            return;
          }

          // Overview table
          const overviewTable = new Table({
            head: ["Metric", "USD", "SOL"],
            style: { head: ["cyan"] },
          });
          overviewTable.push(
            ["Total PnL", fmtUsd(overview.totalPnlUsd), overview.totalPnlSol.toFixed(4)],
            ["Total Fees", fmtUsd(overview.totalFeeUsd), overview.totalFeeSol.toFixed(4)],
            ["Win Rate", fmtPct(overview.winRateUsd), fmtPct(overview.winRateSol)],
            ["APR", fmtPct(overview.apr), "—"],
            ["ROI", fmtPct(overview.roi), "—"],
            ["Open Positions", overview.openingPositions.toString(), "—"],
            ["Total Positions", overview.totalPositions.toString(), "—"],
            ["Win Positions", overview.winPositions.toString(), "—"],
            ["Avg Age (hrs)", overview.avgAgeHours.toFixed(1), "—"],
            ["Total Pools", overview.totalPools.toString(), "—"],
          );
          console.log(chalk.bold("=== Wallet PnL Overview ==="));
          console.log(overviewTable.toString());

          // Open positions table
          if (opening.length > 0) {
            const posTable = new Table({
              head: [
                "Pool",
                "In Range",
                "PnL USD",
                "PnL SOL",
                "Fees USD",
                "Fees SOL",
                "IL USD",
                "Age (hrs)",
                "APR",
              ],
              style: { head: ["cyan"] },
            });
            for (const pos of opening) {
              posTable.push([
                pos.poolName || shortAddr(pos.poolAddress),
                pos.inRange ? chalk.green("✓") : chalk.red("✗"),
                fmtUsd(pos.pnlUsd),
                (pos.pnlSol >= 0 ? "+" : "") + pos.pnlSol.toFixed(4),
                fmtUsd(pos.feeEarnedUsd),
                pos.feeEarnedSol.toFixed(4),
                fmtUsd(pos.ilUsd),
                pos.ageHours.toFixed(1),
                fmtPct(pos.apr),
              ]);
            }
            console.log(chalk.bold("\n=== Open Positions ==="));
            console.log(posTable.toString());
          } else {
            console.log(chalk.gray("\nNo open positions."));
          }

          console.log(
            chalk.gray(
              `\nUpdated: ${new Date().toLocaleTimeString()} | Source: LPAgent API`,
            ),
          );
        };

        if (pollSeconds > 0) {
          console.log(
            chalk.gray(`Polling every ${pollSeconds}s. Press Ctrl+C to stop.\n`),
          );
          await printPnl();
          const timer = setInterval(() => void printPnl(), pollSeconds * 1000);
          process.on("SIGINT", () => {
            clearInterval(timer);
            process.exit(0);
          });
          process.on("SIGTERM", () => {
            clearInterval(timer);
            process.exit(0);
          });
        } else {
          await printPnl();
        }
      } catch (err) {
        fatal(err);
      }
    },
  );

program
  .command("realtime")
  .description("Run only the realtime WebSocket listener, printing events live")
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: RealtimeOpts, cmd: Command) => {
    await realtimeCommand(opts, cmd);
  });

program
  .command("candidates")
  .description("List current Meteora candidates (no LLM, no filters)")
  .option("--limit <n>", "how many pools to list", "20")
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: CandidatesOpts, cmd: Command) => {
    await candidatesCommand(opts, cmd);
  });

program
  .command("config")
  .description("Show resolved config (secrets masked) or its path")
  .option("--show", "show the resolved config (default)", true)
  .option("--path", "print the resolved config file path")
  .option("--config <path>", "path to user-config.json")
  .action((opts: ConfigOpts, cmd: Command) => {
    configCommand(opts, cmd);
  });

interface ReviewOpts {
  limit?: string;
  action?: string;
  pool?: string;
  file?: string;
  detail?: boolean;
  json?: boolean;
  config?: string;
}

program
  .command("review-decisions")
  .description(
    "Inspect the LLM decision log: distribution, top picks, reasoning samples",
  )
  .option("--limit <n>", "show last N decisions in detail", "5")
  .option("--action <type>", "filter by action: ENTER | WATCH | SKIP")
  .option("--pool <name>", "filter by pool name substring")
  .option("--file <path>", "custom decision log file path")
  .option("--no-detail", "skip detailed reasoning, only show summary")
  .option("--json", "output filtered entries as JSON")
  .option("--config <path>", "path to user-config.json")
  .action((opts: ReviewOpts, cmd: Command) => {
    applyGlobalOptions(cmd.optsWithGlobals<{ verbose?: boolean }>());
    try {
      const cfg = loadConfig(opts.config);
      const decisionLogger = new DecisionLogger(
        opts.file ?? cfg.output.decisionLogPath,
      );
      reviewDecisions(decisionLogger, {
        limit: opts.limit ? Number.parseInt(opts.limit, 10) : 5,
        actionFilter: opts.action,
        poolFilter: opts.pool,
        showDetail: opts.detail !== false,
        json: !!opts.json,
      });
      process.exit(0);
    } catch (err) {
      fatal(err);
    }
  });

interface CleanupOpts {
  dryRun?: boolean;
  config?: string;
}

program
  .command("cleanup-empty-positions")
  .description(
    "Close phantom positions (entryAmountX/Y=0) to reclaim ~0.057 SOL rent each",
  )
  .option("--dry-run", "simulate only, don't sign tx", false)
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: CleanupOpts, cmd: Command) => {
    applyGlobalOptions(cmd.optsWithGlobals<{ verbose?: boolean }>());
    const spinner = ora();
    try {
      const base = buildDeps(opts.config);
      const managerDeps = await buildManagerDeps(base.config, base);
      const dryRun = !!opts.dryRun;
      if (dryRun) {
        console.log(
          chalk.bgYellow.black.bold(" DRY-RUN ") +
            chalk.yellow(" no real close tx will be signed."),
        );
      }
      spinner.start("Scanning for empty positions…");
      const runner = new CleanupRunner({
        tracker: managerDeps.tracker,
        actions: managerDeps.actions,
        dryRun,
      });
      const report = await runner.runOnce();
      spinner.succeed(
        `Cleanup complete: ${report.closed.length}/${report.emptyFound} closed, reclaimed ~${report.totalReclaimedSol.toFixed(4)} SOL`,
      );

      if (report.closed.length > 0) {
        console.log("\n" + chalk.green("Closed positions:"));
        for (const c of report.closed) {
          console.log(
            `  ${chalk.bold(c.poolName)} ${chalk.gray(shortAddr(c.positionPubkey))} sig=${c.signature?.slice(0, 16) ?? "-"}…`,
          );
        }
      }
      if (report.failed.length > 0) {
        console.log("\n" + chalk.yellow("Failed (left in tracker for retry):"));
        for (const f of report.failed) {
          console.log(
            `  ${chalk.bold(f.poolName)} ${chalk.gray(shortAddr(f.positionPubkey))}: ${f.error.slice(0, 80)}`,
          );
        }
      }
      process.exit(0);
    } catch (err) {
      spinner.fail("Cleanup failed.");
      fatal(err);
    }
  });

// ---------------------------------------------------------------------------
// `report learning` — observation-only summary of learning loop state.
// ---------------------------------------------------------------------------

interface ReportLearningOpts {
  limit?: string;
  horizon?: string;
  since?: string;
  config?: string;
}

const HORIZON_VALUES = [10, 30, 120, 360] as const;

function parseSinceWindowMs(since: string | undefined): number {
  if (!since) return 86_400_000;
  const trimmed = since.trim().toLowerCase();
  if (trimmed === "24h") return 86_400_000;
  if (trimmed === "7d") return 7 * 86_400_000;
  return 86_400_000;
}

function colorCount(n: number): string {
  return n > 0 ? chalk.green(String(n)) : chalk.gray(String(n));
}

function fmt3(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "-";
  return n.toFixed(3);
}

type LearningDecisionRecord = LearningDecision & Record<string, unknown>;
type LearningOutcomeRecord = LearningOutcome & Record<string, unknown>;
type ShadowScoreRecord = ShadowScore & Record<string, unknown>;
type LearningLessonRecord = LearningLesson & Record<string, unknown>;

function printPendingByHorizon(
  decisions: LearningDecisionRecord[],
  outcomes: LearningOutcomeRecord[],
  horizonsFilter: readonly number[],
): void {
  const now = Date.now();
  const seen = new Set<string>();
  for (const o of outcomes) {
    seen.add(`${o.decisionId}|${o.horizonMinutes}`);
  }
  let any = false;
  for (const horizon of horizonsFilter) {
    let pending = 0;
    for (const d of decisions) {
      if (now - d.timestamp < horizon * 60_000) continue;
      if (seen.has(`${d.id}|${horizon}`)) continue;
      pending += 1;
    }
    any = any || pending > 0;
    const label = `${horizon}m`.padEnd(5);
    console.log(`  ${label} ${colorCount(pending)}`);
  }
  if (!any) {
    console.log(chalk.gray("  (no pending labels)"));
  }
}

function renderShadowTable(scores: ShadowScoreRecord[]): string {
  const table = new Table({
    head: [
      chalk.cyan("decisionId"),
      chalk.cyan("pool"),
      chalk.cyan("llmAction"),
      chalk.cyan("shadowExp"),
      chalk.cyan("mag"),
    ],
    colWidths: [14, 24, 11, 12, 10],
    wordWrap: true,
  });
  for (const s of scores) {
    const id = truncate(s.decisionId, 12);
    const pool = "-"; // ShadowScore doesn't carry pool name; left blank.
    const action = s.disagreement?.llmAction ?? "-";
    table.push([
      chalk.gray(id),
      chalk.gray(pool),
      String(action),
      fmt3(s.expectedScore),
      fmt3(s.disagreement?.magnitude),
    ]);
  }
  return table.toString();
}

function renderBucketTable(
  rows: Array<{ bucketKey: string; avgScore: number; sampleSize: number }>,
): string {
  const table = new Table({
    head: [
      chalk.cyan("bucket"),
      chalk.cyan("avgScore"),
      chalk.cyan("sampleSize"),
    ],
    colWidths: [44, 12, 12],
    wordWrap: true,
  });
  for (const r of rows) {
    const color = r.avgScore >= 0 ? chalk.green : chalk.red;
    table.push([
      chalk.gray(r.bucketKey),
      color(fmt3(r.avgScore)),
      String(r.sampleSize),
    ]);
  }
  return table.toString();
}

async function reportLearningCommand(
  opts: ReportLearningOpts,
  parent: Command,
): Promise<void> {
  applyGlobalOptions(parent.optsWithGlobals<{ verbose?: boolean }>());
  try {
    const config = loadConfig(opts.config);
    const limit = Math.max(1, Number.parseInt(opts.limit ?? "10", 10) || 10);
    const sinceMs = parseSinceWindowMs(opts.since);
    const horizonsFilter: readonly number[] = ((): readonly number[] => {
      if (!opts.horizon) return HORIZON_VALUES;
      const parsed = Number.parseInt(opts.horizon, 10);
      if (HORIZON_VALUES.includes(parsed as (typeof HORIZON_VALUES)[number])) {
        return [parsed];
      }
      return HORIZON_VALUES;
    })();

    const files = config.learning.files;
    const decStore = new JsonlStore<LearningDecisionRecord>(files.decisions);
    const outStore = new JsonlStore<LearningOutcomeRecord>(files.outcomes);
    const scoreStore = new JsonlStore<ShadowScoreRecord>(files.shadowScores);
    const lessonStore = new JsonlStore<LearningLessonRecord>(files.lessons);

    const decisions = decStore.readAll();
    const outcomes = outStore.readAll();
    const shadowScores = scoreStore.readAll();
    const lessons = lessonStore.readAll();

    const index = new EvidenceIndex({
      decisionsStore: decStore,
      outcomesStore: outStore,
      recencyHalfLifeDays: config.learning.recencyHalfLifeDays,
      horizonWeights: config.learning.horizonWeights,
    });
    index.build();
    const buckets = index.allBuckets();

    // ---- A) SUMMARY ----
    console.log(chalk.bold("\nLearning summary"));
    console.log(`  Decisions:     ${colorCount(decisions.length)}`);
    console.log(`  Outcomes:      ${colorCount(outcomes.length)}`);
    console.log(`  Shadow scores: ${colorCount(shadowScores.length)}`);
    console.log(`  Lessons:       ${colorCount(lessons.length)}`);

    // ---- B) PENDING LABELS ----
    console.log(chalk.bold("\nPending labels by horizon:"));
    if (decisions.length === 0) {
      console.log(chalk.gray("  (no data yet)"));
    } else {
      printPendingByHorizon(decisions, outcomes, horizonsFilter);
    }

    // ---- C) RECENT SHADOW SCORES ----
    console.log(
      chalk.bold("\nRecent shadow scores (by disagreement magnitude):"),
    );
    if (shadowScores.length === 0) {
      console.log(chalk.gray("  (no data yet)"));
    } else {
      const top = [...shadowScores]
        .filter((s) => s.disagreement !== undefined)
        .sort(
          (a, b) =>
            Math.abs(b.disagreement?.magnitude ?? 0) -
            Math.abs(a.disagreement?.magnitude ?? 0),
        )
        .slice(0, limit);
      if (top.length === 0) {
        console.log(chalk.gray("  (no shadow scores with disagreement)"));
      } else {
        console.log(renderShadowTable(top));
      }
    }

    // ---- D) TOP GOOD/BAD PATTERNS ----
    console.log(chalk.bold("\nTop good patterns (highest avgScore):"));
    if (buckets.length === 0) {
      console.log(chalk.gray("  (no data yet)"));
    } else {
      const good = buckets.filter((b) => b.sampleSize > 0).slice(0, 5);
      console.log(
        good.length > 0
          ? renderBucketTable(good)
          : chalk.gray("  (no data yet)"),
      );
    }

    console.log(chalk.bold("\nTop bad patterns (lowest avgScore):"));
    if (buckets.length === 0) {
      console.log(chalk.gray("  (no data yet)"));
    } else {
      const bad = [...buckets]
        .filter((b) => b.sampleSize > 0)
        .sort((a, b) => a.avgScore - b.avgScore)
        .slice(0, 5);
      console.log(
        bad.length > 0 ? renderBucketTable(bad) : chalk.gray("  (no data yet)"),
      );
    }

    // ---- E) DISAGREEMENT REPORT ----
    const sinceTs = Date.now() - sinceMs;
    console.log(
      chalk.bold(`\nDisagreement report (last ${opts.since ?? "24h"}):`),
    );
    const recent = shadowScores
      .filter((s) => s.disagreement !== undefined && s.generatedAt >= sinceTs)
      .sort((a, b) => b.generatedAt - a.generatedAt);
    if (recent.length === 0) {
      console.log(chalk.gray("  (no data yet)"));
    } else {
      const decisionsById = new Map<string, LearningDecisionRecord>();
      for (const d of decisions) decisionsById.set(d.id, d);
      for (const s of recent) {
        const d = decisionsById.get(s.decisionId);
        const pool = d?.pool?.name ?? "?";
        const action = s.disagreement?.llmAction ?? "?";
        const rec = s.disagreement?.shadowRecommendation ?? "?";
        const mag = fmt3(s.disagreement?.magnitude);
        const ts = new Date(s.generatedAt).toISOString().slice(11, 19);
        console.log(
          `  [${chalk.gray(ts)}] ${truncate(s.decisionId, 12)} ${chalk.bold(
            pool,
          )} ${action} → shadow recommends ${
            rec === "favor" ? chalk.green(rec) : chalk.red(rec)
          } (mag=${mag})`,
        );
      }
    }

    process.exit(0);
  } catch (err) {
    fatal(err);
  }
}

interface ReportDecisionsOpts {
  pool?: string;
  limit?: string;
  config?: string;
}

function renderDecisionJournalTable(entries: DecisionJournalEntry[]): string {
  const table = new Table({
    head: [
      chalk.cyan("time"),
      chalk.cyan("actor"),
      chalk.cyan("event"),
      chalk.cyan("pool/position"),
      chalk.cyan("action"),
      chalk.cyan("status"),
      chalk.cyan("summary"),
    ],
    colWidths: [21, 10, 20, 22, 10, 10, 42],
    wordWrap: true,
  });
  for (const entry of entries) {
    const subject =
      entry.subject.poolName ??
      entry.subject.poolAddress ??
      entry.subject.positionPubkey ??
      "-";
    table.push([
      chalk.gray(new Date(entry.timestamp).toISOString().slice(0, 19)),
      entry.actor,
      entry.event,
      truncate(subject, 20),
      displayJournalAction(entry),
      entry.status,
      truncate(entry.summary, 40),
    ]);
  }
  return table.toString();
}

function displayJournalAction(entry: DecisionJournalEntry): string {
  if (
    entry.event === "SCREEN_DECISION" &&
    entry.action &&
    ["ENTER", "WATCH", "SKIP"].includes(entry.action)
  ) {
    return `LLM_${entry.action}`;
  }
  return entry.action ?? "-";
}

async function reportDecisionsCommand(
  opts: ReportDecisionsOpts,
  parent: Command,
): Promise<void> {
  applyGlobalOptions(parent.optsWithGlobals<{ verbose?: boolean }>());
  try {
    const config = loadConfig(opts.config);
    const limit = Math.max(1, Number.parseInt(opts.limit ?? "20", 10) || 20);
    const journal = new DecisionJournal(config.memory.journalFile);
    const pool = opts.pool?.trim();
    const looksLikeAddress = pool !== undefined && pool.length >= 32;
    const entries = journal.getRecentDecisions({
      limit,
      ...(pool
        ? looksLikeAddress
          ? { poolAddress: pool }
          : { poolName: pool }
        : {}),
    });

    console.log(chalk.bold("\nDecision journal"));
    console.log(chalk.gray(`  file: ${journal.path()}`));
    if (entries.length === 0) {
      console.log(chalk.gray("  (no matching decisions yet)"));
    } else {
      console.log("\n" + renderDecisionJournalTable(entries));
    }
    process.exit(0);
  } catch (err) {
    fatal(err);
  }
}

const reportCmd = program
  .command("report")
  .description("Read-only reports over learning and decision memory state");

reportCmd
  .command("learning")
  .description(
    "Print learning summary, pending labels, recent shadow scores, top patterns, disagreement report",
  )
  .option("--limit <n>", "limit for recent shadow score table", "10")
  .option(
    "--horizon <m>",
    "filter pending labels to a single horizon (10|30|120|360)",
  )
  .option("--since <window>", "disagreement window (24h | 7d)", "24h")
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: ReportLearningOpts, cmd: Command) => {
    await reportLearningCommand(opts, cmd);
  });

reportCmd
  .command("decisions")
  .description("Print recent decision journal entries")
  .option("--pool <addr|name>", "filter by pool address or name")
  .option("--limit <n>", "maximum decision journal entries to show", "20")
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: ReportDecisionsOpts, cmd: Command) => {
    await reportDecisionsCommand(opts, cmd);
  });

// ---------------------------------------------------------------------------
// positions command — list open positions
// ---------------------------------------------------------------------------
interface PositionsOpts {
  config?: string;
  json?: boolean;
}

async function positionsCommand(opts: PositionsOpts): Promise<void> {
  const cfg = loadConfig(opts.config ?? configPath());
  const tracker = new PositionTracker({
    filePath: path.join(cfg.output?.dataDir ?? "./data", "positions.json"),
  });
  const positions = tracker.listOpen();

  if (opts.json) {
    process.stdout.write(JSON.stringify(positions, null, 2) + "\n");
    return;
  }

  if (positions.length === 0) {
    console.log(chalk.yellow("No open positions."));
    return;
  }

  const table = new Table({
    head: [
      "Mode",
      "Pool",
      "Size",
      "PnL",
      "Fees",
      "In Range",
      "Active/Range",
      "Age",
      "Last Eval",
    ].map((h) => chalk.cyan(h)),
    wordWrap: true,
  });
  for (const p of positions) {
    const last = p.lastEvaluation;
    const ageMinutes =
      last?.ageMinutes ?? Math.max(0, (Date.now() - p.entryTimestamp) / 60_000);
    table.push([
      p.dryRun ? chalk.yellow("PAPER") : chalk.green("LIVE"),
      shortAddr(p.poolAddress),
      fmtUsd(p.entryValueUsd ?? 0),
      last ? fmtPct(last.pnlPct) : "-",
      fmtUsd(last?.claimableFees.usdValue ?? null),
      last ? (last.inRange ? chalk.green("yes") : chalk.red("no")) : "-",
      `${last?.currentActiveBinId ?? "-"} / ${p.lowerBinId}-${p.upperBinId}`,
      fmtAgeMinutes(ageMinutes),
      last
        ? `${fmtAgeMinutes((Date.now() - last.evaluatedAt) / 60_000)} ago`
        : "-",
    ]);
  }
  console.log(table.toString());
  console.log(chalk.dim(`Total: ${positions.length} position(s)`));
}

function fmtAgeMinutes(minutes: number | undefined | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return "-";
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))}m`;
  if (minutes < 24 * 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / (24 * 60)).toFixed(1)}d`;
}

program
  .command("positions")
  .description("List open LP positions")
  .option("--json", "output raw JSON")
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: PositionsOpts) => {
    await positionsCommand(opts).catch(fatal);
  });

// ---------------------------------------------------------------------------
// pnl command — closed position PnL summary
// ---------------------------------------------------------------------------
interface PnlOpts {
  config?: string;
  json?: boolean;
  limit?: string;
}

async function pnlCommand(opts: PnlOpts): Promise<void> {
  const cfg = loadConfig(opts.config ?? configPath());
  const store = new ClosedPositionStore({
    filePath: path.join(
      cfg.output?.dataDir ?? "./data",
      "closed-positions.json",
    ),
  });
  const limit = opts.limit ? parseInt(opts.limit, 10) : 50;
  const entries = store.list().slice(-limit);

  if (opts.json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
    return;
  }

  if (entries.length === 0) {
    console.log(chalk.yellow("No closed positions."));
    return;
  }

  let totalPnlUsd = 0;
  let wins = 0;
  const table = new Table({
    head: ["Pool", "PnL %", "PnL USD", "Exit Reason", "Closed At"].map((h) =>
      chalk.cyan(h),
    ),
  });
  for (const e of entries) {
    const pnl = riskAdjustedLegacyPnlUsd(e.realizedPnlUsd, e.realizedIlUsd);
    const pnlPct =
      e.realizedIlUsd < 0
        ? pnlPctFromUsd(pnl, e.position.entryValueUsd)
        : (e.realizedPnlPct ?? 0);
    totalPnlUsd += pnl;
    if (pnl > 0) wins++;
    table.push([
      shortAddr(e.position.poolAddress),
      fmtPct(pnlPct),
      fmtUsd(pnl),
      e.exitReason ?? "—",
      new Date(e.closedAt).toLocaleString(),
    ]);
  }
  console.log(table.toString());
  console.log(
    chalk.dim(
      `Showing ${entries.length} closed | Win rate: ${wins}/${entries.length} | Total PnL: ${fmtUsd(totalPnlUsd)}`,
    ),
  );
}

program
  .command("pnl")
  .description("PnL summary from closed positions")
  .option("--limit <n>", "max rows to show", "50")
  .option("--json", "output raw JSON")
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: PnlOpts) => {
    await pnlCommand(opts).catch(fatal);
  });

// ---------------------------------------------------------------------------
// pool-detail command
// ---------------------------------------------------------------------------
interface PoolDetailOpts {
  config?: string;
  json?: boolean;
}

async function poolDetailCommand(
  address: string,
  opts: PoolDetailOpts,
): Promise<void> {
  const cfg = loadConfig(opts.config ?? configPath());
  const connection = createConnection(cfg.rpc.url, cfg.rpc.commitment);
  const meteora = new MeteoraTools({
    apiUrl: cfg.meteora.apiUrl,
    programId: cfg.meteora.programId,
    connection,
    timeframe: cfg.meteora.timeframe,
    category: cfg.meteora.category,
  });
  const spinner = ora(`Fetching pool ${shortAddr(address)}…`).start();
  const pool = await meteora.fetchPairByAddress(address);
  spinner.stop();

  if (!pool) {
    console.log(chalk.red("Pool not found."));
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(pool, null, 2) + "\n");
    return;
  }

  const rows: [string, string][] = [
    ["Address", pool.address],
    ["Name", pool.name ?? "—"],
    ["TVL", fmtUsd(pool.tvl ?? 0)],
    ["Volume 24h", fmtUsd(pool.volume24h ?? 0)],
    ["Fees 24h", fmtUsd(pool.fees24h ?? 0)],
    ["Bin Step", String(pool.binStep ?? "—")],
    ["Active Bin ID", String(pool.activeBinId ?? "—")],
    ["Base Token", pool.tokenX?.symbol ?? "—"],
    ["Quote Token", pool.tokenY?.symbol ?? "—"],
  ];
  const table = new Table();
  for (const [k, v] of rows) table.push({ [chalk.cyan(k)]: v });
  console.log(table.toString());
}

program
  .command("pool-detail <address>")
  .description("Show detailed pool info from Meteora API")
  .option("--json", "output raw JSON")
  .option("--config <path>", "path to user-config.json")
  .action(async (address: string, opts: PoolDetailOpts) => {
    await poolDetailCommand(address, opts).catch(fatal);
  });

// ---------------------------------------------------------------------------
// active-bin command
// ---------------------------------------------------------------------------
interface ActiveBinOpts {
  config?: string;
}

async function activeBinCommand(
  address: string,
  opts: ActiveBinOpts,
): Promise<void> {
  const cfg = loadConfig(opts.config ?? configPath());
  const connection = createConnection(cfg.rpc.url, cfg.rpc.commitment);
  const meteora = new MeteoraTools({
    apiUrl: cfg.meteora.apiUrl,
    programId: cfg.meteora.programId,
    connection,
    timeframe: cfg.meteora.timeframe,
    category: cfg.meteora.category,
  });
  const spinner = ora(`Fetching active bin for ${shortAddr(address)}…`).start();
  const partial = await meteora.enrichOnChain(address);
  spinner.stop();

  if (partial.activeBinId == null) {
    console.log(
      chalk.yellow(
        "Could not determine active bin (on-chain enrichment returned no data).",
      ),
    );
    return;
  }
  console.log(
    chalk.green("Active Bin ID:"),
    chalk.bold(String(partial.activeBinId)),
  );
}

program
  .command("active-bin <address>")
  .description("Fetch the current active bin ID for a pool")
  .option("--config <path>", "path to user-config.json")
  .action(async (address: string, opts: ActiveBinOpts) => {
    await activeBinCommand(address, opts).catch(fatal);
  });

// ---------------------------------------------------------------------------
// pool-ohlcv command
// ---------------------------------------------------------------------------
interface PoolOhlcvOpts {
  config?: string;
  json?: boolean;
}

async function poolOhlcvCommand(
  address: string,
  opts: PoolOhlcvOpts,
): Promise<void> {
  const cfg = loadConfig(opts.config ?? configPath());
  const connection = createConnection(cfg.rpc.url, cfg.rpc.commitment);
  const meteora = new MeteoraTools({
    apiUrl: cfg.meteora.apiUrl,
    programId: cfg.meteora.programId,
    connection,
    timeframe: cfg.meteora.timeframe,
    category: cfg.meteora.category,
  });
  const spinner = ora(`Fetching metrics for ${shortAddr(address)}…`).start();
  const pool = await meteora.fetchPairByAddress(address);
  spinner.stop();

  if (!pool) {
    console.log(chalk.red("Pool not found."));
    return;
  }

  const feeActiveTvlRatio =
    pool.activeTvl > 0 ? (pool.fees24h / pool.activeTvl) * 100 : null;
  const metrics = {
    address: pool.address,
    name: pool.name,
    volume24h: pool.volume24h,
    fees24h: pool.fees24h,
    tvl: pool.tvl,
    feeActiveTvlRatio,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(metrics, null, 2) + "\n");
    return;
  }

  const table = new Table();
  table.push(
    { [chalk.cyan("Name")]: pool.name ?? "—" },
    { [chalk.cyan("Volume 24h")]: fmtUsd(pool.volume24h ?? 0) },
    { [chalk.cyan("Fees 24h")]: fmtUsd(pool.fees24h ?? 0) },
    { [chalk.cyan("TVL")]: fmtUsd(pool.tvl ?? 0) },
    {
      [chalk.cyan("Fee/TVL Ratio")]:
        feeActiveTvlRatio != null ? fmtPct(feeActiveTvlRatio / 100) : "—",
    },
  );
  console.log(table.toString());
}

program
  .command("pool-ohlcv <address>")
  .description("Show volume/fee metrics for a pool")
  .option("--json", "output raw JSON")
  .option("--config <path>", "path to user-config.json")
  .action(async (address: string, opts: PoolOhlcvOpts) => {
    await poolOhlcvCommand(address, opts).catch(fatal);
  });

// ---------------------------------------------------------------------------
// pool-compare command
// ---------------------------------------------------------------------------
interface PoolCompareOpts {
  config?: string;
}

async function poolCompareCommand(
  addr1: string,
  addr2: string,
  opts: PoolCompareOpts,
): Promise<void> {
  const cfg = loadConfig(opts.config ?? configPath());
  const connection = createConnection(cfg.rpc.url, cfg.rpc.commitment);
  const meteora = new MeteoraTools({
    apiUrl: cfg.meteora.apiUrl,
    programId: cfg.meteora.programId,
    connection,
    timeframe: cfg.meteora.timeframe,
    category: cfg.meteora.category,
  });
  const spinner = ora("Fetching both pools…").start();
  const [p1, p2] = await Promise.all([
    meteora.fetchPairByAddress(addr1),
    meteora.fetchPairByAddress(addr2),
  ]);
  spinner.stop();

  if (!p1 || !p2) {
    console.log(chalk.red(`Pool not found: ${!p1 ? addr1 : addr2}`));
    return;
  }

  const table = new Table({
    head: ["Metric", shortAddr(addr1), shortAddr(addr2)].map((h) =>
      chalk.cyan(h),
    ),
  });
  const r1 = p1.activeTvl > 0 ? (p1.fees24h / p1.activeTvl) * 100 : null;
  const r2 = p2.activeTvl > 0 ? (p2.fees24h / p2.activeTvl) * 100 : null;
  table.push(
    ["Name", p1.name ?? "—", p2.name ?? "—"],
    ["TVL", fmtUsd(p1.tvl ?? 0), fmtUsd(p2.tvl ?? 0)],
    ["Volume 24h", fmtUsd(p1.volume24h ?? 0), fmtUsd(p2.volume24h ?? 0)],
    ["Fees 24h", fmtUsd(p1.fees24h ?? 0), fmtUsd(p2.fees24h ?? 0)],
    ["Bin Step", String(p1.binStep ?? "—"), String(p2.binStep ?? "—")],
    [
      "Fee/TVL",
      r1 != null ? fmtPct(r1 / 100) : "—",
      r2 != null ? fmtPct(r2 / 100) : "—",
    ],
  );
  console.log(table.toString());
}

program
  .command("pool-compare <addr1> <addr2>")
  .description("Compare two pools side by side")
  .option("--config <path>", "path to user-config.json")
  .action(async (addr1: string, addr2: string, opts: PoolCompareOpts) => {
    await poolCompareCommand(addr1, addr2, opts).catch(fatal);
  });

// ---------------------------------------------------------------------------
// study-pool command — LLM analysis of a pool
// ---------------------------------------------------------------------------
interface StudyPoolOpts {
  config?: string;
}

async function studyPoolCommand(
  address: string,
  opts: StudyPoolOpts,
): Promise<void> {
  const cfg = loadConfig(opts.config ?? configPath());
  const connection = createConnection(cfg.rpc.url, cfg.rpc.commitment);
  const meteora = new MeteoraTools({
    apiUrl: cfg.meteora.apiUrl,
    programId: cfg.meteora.programId,
    connection,
    timeframe: cfg.meteora.timeframe,
    category: cfg.meteora.category,
  });
  const llm = createLlmProvider(cfg.llm);

  const spinner = ora(`Fetching pool data for ${shortAddr(address)}…`).start();
  const pool = await meteora.fetchPairByAddress(address);
  spinner.stop();

  if (!pool) {
    console.log(chalk.red("Pool not found."));
    return;
  }

  const userPrompt = [
    `You are analysing a Meteora DLMM pool for LP suitability.`,
    ``,
    `Pool: ${pool.name ?? address}`,
    `Address: ${pool.address}`,
    `TVL: ${fmtUsd(pool.tvl ?? 0)}`,
    `Volume 24h: ${fmtUsd(pool.volume24h ?? 0)}`,
    `Fees 24h: ${fmtUsd(pool.fees24h ?? 0)}`,
    `Bin Step: ${pool.binStep ?? "—"}`,
    `Active Bin ID: ${pool.activeBinId ?? "—"}`,
    `Base Token: ${pool.tokenX?.symbol ?? "—"}`,
    `Quote Token: ${pool.tokenY?.symbol ?? "—"}`,
    ``,
    `Provide a concise study: opportunity, risks, suggested range strategy, and overall verdict (enter/watch/skip).`,
  ].join("\n");

  const llmSpinner = ora("Consulting LLM…").start();
  const result = await llm.generate({
    systemPrompt:
      "You are a DeFi liquidity provision analyst specialising in Meteora DLMM pools.",
    userPrompt,
  });
  llmSpinner.stop();

  if (!result.ok) {
    console.log(chalk.red("LLM error:"), result.error ?? "unknown");
    return;
  }
  console.log("\n" + result.raw);
}

program
  .command("study-pool <address>")
  .description("Ask the LLM to analyse a pool")
  .option("--config <path>", "path to user-config.json")
  .action(async (address: string, opts: StudyPoolOpts) => {
    await studyPoolCommand(address, opts).catch(fatal);
  });

// ---------------------------------------------------------------------------
// token-info command
// ---------------------------------------------------------------------------
interface TokenInfoOpts {
  config?: string;
  json?: boolean;
}

async function tokenInfoCommand(
  mint: string,
  opts: TokenInfoOpts,
): Promise<void> {
  const cfg = loadConfig(opts.config ?? configPath());
  const connection = createConnection(cfg.rpc.url, cfg.rpc.commitment);
  const jupiter = new JupiterTools({
    baseUrl: cfg.jupiter.baseUrl,
    apiKey: cfg.jupiter.apiKey,
  });
  const spinner = ora(`Fetching token info for ${mint}…`).start();
  const info = await jupiter.getTokenInfo(mint);
  spinner.stop();

  if (!info) {
    console.log(chalk.red("Token not found."));
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(info, null, 2) + "\n");
    return;
  }

  const table = new Table();
  const entries: [string, string][] = [
    ["Symbol", info.symbol ?? "—"],
    ["Name", info.name ?? "—"],
    ["Mint", info.mint ?? mint],
    ["Decimals", String(info.decimals ?? "—")],
    ["Holders", String(info.holders ?? "—")],
    ["Market Cap", fmtUsd(info.marketCap ?? 0)],
    ["Organic Score", String(info.organicScore ?? "—")],
    [
      "Launchpad",
      typeof info.launchpad === "string"
        ? info.launchpad
        : info.launchpad != null
          ? JSON.stringify(info.launchpad)
          : "—",
    ],
  ];
  for (const [k, v] of entries) table.push({ [chalk.cyan(k)]: v });
  console.log(table.toString());
}

program
  .command("token-info <mint>")
  .description("Jupiter token info for a mint address")
  .option("--json", "output raw JSON")
  .option("--config <path>", "path to user-config.json")
  .action(async (mint: string, opts: TokenInfoOpts) => {
    await tokenInfoCommand(mint, opts).catch(fatal);
  });

// ---------------------------------------------------------------------------
// token-holders command
// ---------------------------------------------------------------------------
interface TokenHoldersOpts {
  config?: string;
  limit?: string;
  json?: boolean;
}

async function tokenHoldersCommand(
  mint: string,
  opts: TokenHoldersOpts,
): Promise<void> {
  const cfg = loadConfig(opts.config ?? configPath());
  const connection = createConnection(cfg.rpc.url, cfg.rpc.commitment);
  const limit = opts.limit ? parseInt(opts.limit, 10) : 20;
  const spinner = ora(`Fetching top holders for ${shortAddr(mint)}…`).start();

  let holders: { address: string; amount: string; uiAmount: number }[] = [];
  try {
    const rpcUrl = connection.rpcEndpoint;
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenLargestAccounts",
      params: [mint, { commitment: "confirmed" }],
    };
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      result?: {
        value?: { address: string; amount: string; uiAmount: number }[];
      };
    };
    holders = (json.result?.value ?? []).slice(0, limit);
  } catch (err) {
    spinner.stop();
    console.log(
      chalk.red("RPC error:"),
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  spinner.stop();

  if (opts.json) {
    process.stdout.write(JSON.stringify(holders, null, 2) + "\n");
    return;
  }

  if (holders.length === 0) {
    console.log(chalk.yellow("No holders found."));
    return;
  }

  const table = new Table({
    head: ["#", "Account", "UI Amount"].map((h) => chalk.cyan(h)),
  });
  holders.forEach((h, i) => {
    table.push([String(i + 1), shortAddr(h.address), String(h.uiAmount)]);
  });
  console.log(table.toString());
}

program
  .command("token-holders <mint>")
  .description("Show top token holders via Helius RPC")
  .option("--limit <n>", "max holders to show", "20")
  .option("--json", "output raw JSON")
  .option("--config <path>", "path to user-config.json")
  .action(async (mint: string, opts: TokenHoldersOpts) => {
    await tokenHoldersCommand(mint, opts).catch(fatal);
  });

// ---------------------------------------------------------------------------
// blacklist commands
// ---------------------------------------------------------------------------
interface BlacklistAddOpts {
  symbol?: string;
  reason?: string;
  config?: string;
}

interface BlacklistListOpts {
  json?: boolean;
  config?: string;
}

const blacklistCmd = program
  .command("blacklist")
  .description("Manage the token blacklist");

blacklistCmd
  .command("add <mint>")
  .description("Add a token to the blacklist")
  .option("--symbol <sym>", "token symbol", "UNKNOWN")
  .option("--reason <text>", "reason for blacklisting", "manual")
  .option("--config <path>", "path to user-config.json")
  .action(async (mint: string, opts: BlacklistAddOpts) => {
    const cfg = loadConfig(opts.config ?? configPath());
    const dataDir = cfg.output?.dataDir ?? "./data";
    const store = new BlacklistStore(
      path.join(dataDir, "token-blacklist.json"),
    );
    await store.load();
    store.addUser(mint, opts.symbol ?? "UNKNOWN", opts.reason ?? "manual");
    console.log(
      chalk.green(`✓ Blacklisted ${mint} (${opts.symbol ?? "UNKNOWN"})`),
    );
  });

blacklistCmd
  .command("remove <mint>")
  .description("Remove a token from the blacklist")
  .option("--config <path>", "path to user-config.json")
  .action(async (mint: string, opts: { config?: string }) => {
    const cfg = loadConfig(opts.config ?? configPath());
    const dataDir = cfg.output?.dataDir ?? "./data";
    const store = new BlacklistStore(
      path.join(dataDir, "token-blacklist.json"),
    );
    await store.load();
    const removed = store.remove(mint);
    if (removed) {
      console.log(chalk.green(`✓ Removed ${mint} from blacklist`));
    } else {
      console.log(chalk.yellow(`${mint} was not in the blacklist`));
    }
  });

blacklistCmd
  .command("list")
  .description("List all blacklisted tokens")
  .option("--json", "output raw JSON")
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: BlacklistListOpts) => {
    const cfg = loadConfig(opts.config ?? configPath());
    const dataDir = cfg.output?.dataDir ?? "./data";
    const store = new BlacklistStore(
      path.join(dataDir, "token-blacklist.json"),
    );
    await store.load();
    const entries = store.list();

    if (opts.json) {
      process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
      return;
    }

    if (entries.length === 0) {
      console.log(chalk.yellow("Blacklist is empty."));
      return;
    }

    const table = new Table({
      head: ["Mint", "Symbol", "Source", "Reason", "Added At"].map((h) =>
        chalk.cyan(h),
      ),
    });
    for (const e of entries) {
      table.push([
        shortAddr(e.mint),
        e.symbol,
        e.source,
        e.reason,
        new Date(e.addedAt).toLocaleString(),
      ]);
    }
    console.log(table.toString());
    console.log(chalk.dim(`Total: ${entries.length} blacklisted token(s)`));
  });

// ---------------------------------------------------------------------------
// pool-memory commands
// ---------------------------------------------------------------------------
interface PoolMemoryShowOpts {
  json?: boolean;
  config?: string;
}

interface PoolMemoryNoteOpts {
  config?: string;
}

const poolMemoryCmd = program
  .command("pool-memory")
  .description("Manage the pool memory store");

poolMemoryCmd
  .command("show")
  .description("List all remembered pools")
  .option("--json", "output raw JSON")
  .option("--config <path>", "path to user-config.json")
  .action(async (opts: PoolMemoryShowOpts) => {
    const cfg = loadConfig(opts.config ?? configPath());
    const dataDir = cfg.output?.dataDir ?? "./data";
    const store = new PoolMemoryStore(path.join(dataDir, "pool-memory.json"));
    await store.load();
    const entries = store.list();

    if (opts.json) {
      process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
      return;
    }

    if (entries.length === 0) {
      console.log(chalk.yellow("Pool memory is empty."));
      return;
    }

    const now = Date.now();
    const table = new Table({
      head: ["Pool", "Last Closed", "Cooldown Until", "PnL %", "Note"].map(
        (h) => chalk.cyan(h),
      ),
    });
    for (const e of entries) {
      const onCooldown = e.cooldownUntil ? e.cooldownUntil > now : false;
      const cooldownStr = e.cooldownUntil
        ? (onCooldown ? chalk.red : chalk.dim)(
            new Date(e.cooldownUntil).toLocaleString(),
          )
        : "—";
      table.push([
        shortAddr(e.poolAddress),
        new Date(e.lastClosedAt).toLocaleString(),
        cooldownStr,
        e.pnlPct != null ? fmtPct(e.pnlPct / 100) : "—",
        e.note ?? "—",
      ]);
    }
    console.log(table.toString());
    console.log(chalk.dim(`Total: ${entries.length} pool(s) in memory`));
  });

poolMemoryCmd
  .command("note <address> <text>")
  .description("Attach a note to a remembered pool")
  .option("--config <path>", "path to user-config.json")
  .action(async (address: string, text: string, opts: PoolMemoryNoteOpts) => {
    const cfg = loadConfig(opts.config ?? configPath());
    const dataDir = cfg.output?.dataDir ?? "./data";
    const store = new PoolMemoryStore(path.join(dataDir, "pool-memory.json"));
    await store.load();
    const ok = store.setNote(address, text);
    if (ok) {
      console.log(chalk.green(`✓ Note set for ${shortAddr(address)}`));
    } else {
      console.log(
        chalk.yellow(`Pool ${shortAddr(address)} not found in memory.`),
      );
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  fatal(err);
});
