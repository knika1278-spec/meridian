#!/usr/bin/env node
/**
 * cli-manager.ts — Standalone manager daemon entrypoint.
 *
 * Runs only the ManagerAgent (position lifecycle cron), CleanupRunner,
 * optional CapitalManager, CommandConsumer (manage/open/close/claim),
 * ConfigWatcher, heartbeat watchdog, and Telegram notifier.
 *
 * Designed to run alongside cli.js (screener) as separate PM2 processes
 * sharing file-based state (positions.json, closed-positions.json, etc.).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";

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
import { formatProgressLine, type ProgressSink } from "./utils/progress.js";

import { MeteoraTools } from "./tools/meteora.tools.js";
import { JupiterTools } from "./tools/jupiter.tools.js";
import { OkxTools } from "./tools/okx.tools.js";
import { MeteoraPnlTools } from "./tools/meteora-pnl.tools.js";
import { createConnection } from "./tools/helius.tools.js";
import { WalletTools } from "./tools/wallet.tools.js";
import { MeteoraActions } from "./tools/meteora-actions.tools.js";
import { JupiterSwapClient } from "./tools/jupiter-swap.tools.js";
import { CapitalManager } from "./agents/capital-manager.js";
import { CleanupRunner } from "./agents/cleanup-runner.js";
import { ManagerAgent, type ManagerDeps } from "./agents/manager.agent.js";
import { PositionTracker } from "./agents/position-tracker.js";
import { ClosedPositionStore } from "./agents/closed-position-store.js";
import { TradeLedger } from "./agents/trade-ledger.js";
import { TradingCircuitBreaker } from "./agents/circuit-breaker.js";
import { LessonStore } from "./agents/lesson-store.js";
import { BlacklistStore } from "./agents/blacklist-store.js";
import { PoolMemoryStore } from "./agents/pool-memory-store.js";
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

import type {
  UserConfig,
  LearningDecision,
  LearningOutcome,
  LearningLesson,
  ShadowScore,
  DecisionJournalEntry,
  BotProgressEvent,
  EntrySnapshot,
  OpenPositionInput,
} from "./types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

interface PackageJsonShape {
  version?: string;
}

function readPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    return (JSON.parse(raw) as PackageJsonShape).version ?? "0.0.0";
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

function createProgressSink(opts: {
  spinner?: ReturnType<typeof ora>;
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
  if (cloned.jupiter.apiKey) cloned.jupiter.apiKey = "***";
  if (cloned.okx?.apiKey) cloned.okx.apiKey = "***";
  if (cloned.llm.baseUrl)
    cloned.llm.baseUrl = maskApiKeyInUrl(cloned.llm.baseUrl);
  return cloned;
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface JsonlEmitters {
  progress: JsonlEmitter;
}

interface BuiltDeps {
  config: UserConfig;
  meteora: MeteoraTools;
  jupiter: JupiterTools;
  okx: OkxTools;
  meteoraPnl?: MeteoraPnlTools;
  decisionLogger: DecisionLogger;
  emitters: JsonlEmitters;
  signalSnapshot: RealtimeSignalSnapshotStore;
}

interface LearningManagerSide {
  tracker: PositionTracker;
  closedStore: ClosedPositionStore;
  lessonStore: LessonStore;
  evaluator: PositionEvaluator;
}

interface LearningDeps {
  recorder: LearningRecorder;
  ranker: ShadowRanker;
  collector: OutcomeCollector | null;
  miner: LessonMiner | null;
  snapshotEmitter: LearningSnapshotEmitter;
  signalWeightsEmitter: SignalWeightsEmitter;
}

interface MemoryDeps {
  journal: DecisionJournal;
  router: MemoryRouter;
}

// ---------------------------------------------------------------------------
// Factory functions (inlined from cli.ts — manager process has no screener)
// ---------------------------------------------------------------------------

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
  const decisionLogger = new DecisionLogger(config.output.decisionLogPath);
  const dataDir = path.resolve(config.output.dataDir);
  const emitters: JsonlEmitters = {
    progress: new JsonlEmitter(path.join(dataDir, "progress.jsonl")),
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
    decisionLogger,
    emitters,
    signalSnapshot,
  };
}

async function buildManagerDeps(
  config: UserConfig,
  base: BuiltDeps,
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
  const lessonStore = new LessonStore({
    filePath: config.manager.lessonsFile,
    lessonRecencyDays: config.learning.lessonRecencyDays,
  });
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
    blacklistStore,
    poolMemoryStore,
    tradeLedger,
    circuitBreaker,
  };
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
    childLogger("cli-manager").warn(
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

// ---------------------------------------------------------------------------
// Start command (manager-only daemon)
// ---------------------------------------------------------------------------

async function startManagerDaemon(opts: {
  config?: string;
  verbose?: boolean;
}): Promise<void> {
  applyGlobalOptions(opts);
  const mgrLog = childLogger("cli-manager");

  const spinner = ora({
    text: "Initializing manager daemon…",
    color: "cyan",
  }).start();

  // Build shared deps (no candidates/llmRuns emitters — screener owns those)
  const base = buildDeps(opts.config);
  const { config } = base;

  spinner.text = "Configuration loaded";
  mgrLog.info(
    {
      config: maskConfig(config),
      dryRun: config.dryRun,
      mode: config.learning.mode,
    },
    "manager daemon starting",
  );

  console.log(
    chalk.cyan(
      `\n⚙  meteora-manager v${readPackageVersion()}  dryRun=${String(config.dryRun)}  mode=${config.learning.mode}\n`,
    ),
  );

  // Memory
  const memory = buildMemoryDeps(config, (entry) => {
    mgrLog.debug({ entry }, "journal entry appended");
  });

  // Telegram
  const telegram = buildTelegramNotifier(config, memory);
  if (telegram) {
    telegram.startPolling();
    await telegram.sendControlCenter();
    mgrLog.info("telegram notifier started");
  }

  // Progress sink
  const progressSink = createProgressSink({ telegram, terminal: true });

  // Manager deps
  const managerDeps = await buildManagerDeps(config, base);
  const { tracker, closedStore, lessonStore, evaluator } = managerDeps;

  // Learning (manager side owns outcome collection + lesson mining)
  const managerSide: LearningManagerSide = {
    tracker,
    closedStore,
    lessonStore,
    evaluator,
  };
  const learning = buildLearningDeps(config, base, managerSide);

  // Manager agent
  const manager = new ManagerAgent(config, {
    ...managerDeps,
    ...(learning
      ? {
          learningRecorder: learning.recorder,
          outcomeCollector: learning.collector ?? undefined,
          lessonMiner: learning.miner ?? undefined,
          snapshotEmitter: learning.snapshotEmitter,
          signalWeightsEmitter: learning.signalWeightsEmitter,
        }
      : {}),
    ...(memory
      ? { decisionJournal: memory.journal, memoryRouter: memory.router }
      : {}),
    onProgress: progressSink,
  });

  // CleanupRunner — reclaim rent from phantom/empty positions at startup
  spinner.text = "Running cleanup…";
  try {
    const cleanup = new CleanupRunner({
      tracker,
      actions: managerDeps.actions,
      dryRun: config.dryRun,
    });
    await cleanup.runOnce();
    spinner.succeed("Cleanup complete");
  } catch (err) {
    spinner.warn(`Cleanup skipped: ${getErrorMessage(err)}`);
  }

  // Capital manager (optional)
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
          `Capital ${result.action}: ${inMint}… → ${outMint}…  ${
            result.signature
              ? chalk.gray("sig=" + result.signature.slice(0, 16) + "…")
              : ""
          }`,
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

  // Start manager cron
  manager.startAuto();
  mgrLog.info({ cron: manager.getCronExpression() }, "manager cron started");
  console.log(
    chalk.green(`✓ Manager cron running [${manager.getCronExpression()}]`),
  );

  // ConfigWatcher (hot-reload; manager only — screener daemon owns its own watcher)
  const watcher = new ConfigWatcher({
    configPath: opts.config ?? configPath(),
    onReload: (next): void => {
      manager.updateMutableConfig(next);
    },
  });
  watcher.start();

  // CommandConsumer — handles manage/open/close/claim; skips screen (screener owns it)
  const commandsFile = path.resolve(
    config.output.dataDir ?? "./data",
    "commands.jsonl",
  );
  const consumer = new CommandConsumer({
    filePath: commandsFile,
    onCommand: async (cmd: BotCommand): Promise<void> => {
      const cmdLog = childLogger("command");
      cmdLog.info({ cmd }, "received command");
      try {
        switch (cmd.kind) {
          case "manage": {
            await manager.runOnce({ commandId: cmd.id });
            break;
          }
          case "open": {
            if (!cmd.args?.poolAddress) {
              cmdLog.warn({ cmd }, "open command missing poolAddress");
              break;
            }
            const sizeUsd =
              (cmd.args.sizeUsd as number | undefined) ??
              config.manager.positionSizeUsd;
            const rangeBps =
              (cmd.args.rangeBps as number | undefined) ??
              config.manager.defaultRangeBps;
            if (sizeUsd === undefined || rangeBps === undefined) {
              cmdLog.warn(
                { cmd },
                "open command missing sizeUsd or rangeBps (no config default)",
              );
              break;
            }
            const cycleId =
              typeof cmd.args.cycleId === "string"
                ? cmd.args.cycleId
                : typeof cmd.args.cycleIdOnEnter === "string"
                  ? cmd.args.cycleIdOnEnter
                  : undefined;
            const openInput: OpenPositionInput = {
              poolAddress: cmd.args.poolAddress as string,
              sizeUsd,
              rangeBps,
              dryRun: (cmd.args.dryRun as boolean | undefined) ?? config.dryRun,
              paper: cmd.args.paper === true,
              ...(cycleId ? { cycleIdOnEnter: cycleId } : {}),
              ...(isObjectRecord(cmd.args.entrySnapshot)
                ? {
                    entrySnapshot: cmd.args
                      .entrySnapshot as unknown as EntrySnapshot,
                  }
                : {}),
              ...(typeof cmd.args.notes === "string"
                ? { notes: cmd.args.notes }
                : {}),
            };
            if (openInput.paper) {
              await manager.openPaper(
                openInput,
                cycleId ? { cycleId } : undefined,
              );
            } else {
              await manager.open(openInput, cycleId ? { cycleId } : undefined);
            }
            break;
          }
          case "close": {
            if (!cmd.args?.positionPubkey) {
              cmdLog.warn({ cmd }, "close command missing positionPubkey");
              break;
            }
            await manager.closeTrackedPosition(
              cmd.args.positionPubkey as string,
              (cmd.args.reason as string | undefined) ?? "manual-close",
              { commandId: cmd.id },
            );
            break;
          }
          case "claim": {
            if (!cmd.args?.positionPubkey || !cmd.args?.poolAddress) {
              cmdLog.warn(
                { cmd },
                "claim command missing positionPubkey or poolAddress",
              );
              break;
            }
            await managerDeps.actions.claimFees({
              positionPubkey: cmd.args.positionPubkey as string,
              poolAddress: cmd.args.poolAddress as string,
              dryRun: (cmd.args.dryRun as boolean | undefined) ?? config.dryRun,
            });
            break;
          }
          case "screen":
            // Screen commands are handled by the screener daemon; ignore here
            cmdLog.debug({ cmd }, "screen command ignored by manager daemon");
            break;
          default:
            cmdLog.warn({ cmd }, "unknown command type");
        }
      } catch (err) {
        cmdLog.error({ err, cmd }, "command failed");
      }
    },
  });
  consumer.start();

  // ---------------------------------------------------------------------------
  // Heartbeat watchdog (manager-only stall detection)
  // ---------------------------------------------------------------------------

  const HEARTBEAT_MS = 60_000;
  const STALL_FACTOR = 2.5;
  const hbLog = childLogger("heartbeat");
  const learningCfg = config.learning;

  const parseEveryNMin = (expr: string): number | null => {
    const m = expr.trim().match(/^\*\/(\d+) \* \* \* \*$/);
    return m ? Number(m[1]) : null;
  };

  const safeCount = (p: string): number => {
    try {
      const raw = fs.readFileSync(p, "utf-8");
      return raw.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  };

  const heartbeatTimer = setInterval(() => {
    try {
      const dec = safeCount(learningCfg.files.decisions);
      const out = safeCount(learningCfg.files.outcomes);
      const les = safeCount(learningCfg.files.lessons);
      const now = Date.now();
      const managerLast = manager.getLastCycleAt();
      const managerSilentMs = managerLast ? now - managerLast : null;

      hbLog.info(
        {
          pid: process.pid,
          decisions: dec,
          outcomes: out,
          lessons: les,
          managerSilentMs,
        },
        "heartbeat",
      );

      // Manager stall check
      const managerEveryMin = parseEveryNMin(manager.getCronExpression());
      if (managerEveryMin && managerLast && manager.isCronRunning()) {
        const stallThresholdMs = managerEveryMin * 60_000 * STALL_FACTOR;
        if (managerSilentMs !== null && managerSilentMs > stallThresholdMs) {
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
    } catch {
      // must never crash the watchdog
    }
  }, HEARTBEAT_MS);

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  const shutdown = async (signal: string): Promise<void> => {
    console.log("\n" + chalk.cyan(`Shutting down manager… (signal=${signal})`));
    try {
      clearInterval(heartbeatTimer);
      watcher.stop();
      consumer.stop();
      if (telegram) telegram.stopPolling();
      manager.stopAuto();
    } catch (err) {
      logger.error({ err }, "error during manager shutdown");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  mgrLog.info("manager daemon fully started");
  console.log(chalk.green("✓ Manager daemon running. Press Ctrl+C to stop.\n"));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("meteora-manager")
  .description("Meteora DLMM manager daemon — position lifecycle only")
  .version(readPackageVersion())
  .option("--config <path>", "Path to user-config.json")
  .option("--verbose", "Enable debug logging");

program
  .command("start")
  .description(
    "Start manager daemon (position cron, cleanup, capital rebalance)",
  )
  .action(async () => {
    const opts = program.opts<{ config?: string; verbose?: boolean }>();
    try {
      await startManagerDaemon(opts);
    } catch (err) {
      fatal(err);
    }
  });

program.parseAsync(process.argv).catch(fatal);
