import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { UserConfig } from "../types/index.js";
import { DEFAULT_ENTRY_POLICY } from "../utils/entry-policy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HardFiltersSchema = z.object({
  feeActiveTvlRatioMin: z.number().min(0),
  organicScoreMin: z.number().min(0).max(100),
  holdersMin: z.number().int().min(0),
  marketCapMin: z.number().min(0),
  marketCapMax: z.number().min(0),
  binStepMin: z.number().int().min(0),
  binStepMax: z.number().int().min(0),
  tvlMin: z.number().min(0),
  tvlMax: z.number().min(0),
  volume24hMin: z.number().min(0).optional(),
  excludedTokens: z.array(z.string()).optional(),
  includedTokens: z.array(z.string()).optional(),
  okxRiskScoreMax: z.number().min(0).optional(),
  minTokenFeesSol: z.number().min(0).optional(),
  maxBundlersPct: z.number().min(0).max(100).optional(),
  maxTop10Pct: z.number().min(0).max(100).optional(),
  blockedLaunchpads: z.array(z.string()).optional(),
  smartMoneyNetFlowUsdMin: z.number().optional(),
  requireMintAuthorityDisabled: z.boolean().optional(),
  requireFreezeAuthorityDisabled: z.boolean().optional(),
  blacklistFile: z.string().optional(),
  // Hard-reject pools with zero recent on-chain activity (no swap/liquidity
  // events in the Helius WS buffer). Guards against dead/illiquid pools that
  // pass fee-ratio filters on stale 5m candles. Only effective when the
  // realtime WS listener is running; disable if running without --realtime.
  requireRecentActivity: z.boolean().optional(),
});

const OkxConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  chainShortName: z.string().optional(),
  enabled: z.boolean().optional(),
});

const MeteoraPnlConfigSchema = z.object({
  baseUrl: z.string().url(),
  enabled: z.boolean().optional(),
});

const LpAgentConfigSchema = z.object({
  baseUrl: z.string().url().default("https://api.lpagent.io"),
  apiKey: z.string().optional(),
  enabled: z.boolean().default(false),
  pollIntervalMs: z.number().int().positive().default(10_000),
});

const EntryPolicyConfigSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_ENTRY_POLICY.enabled),
    mode: z.enum(["observe", "enforce"]).default(DEFAULT_ENTRY_POLICY.mode),
    maxLlmCandidates: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_ENTRY_POLICY.maxLlmCandidates),
    maxDeploysPerCycle: z
      .number()
      .int()
      .min(0)
      .default(DEFAULT_ENTRY_POLICY.maxDeploysPerCycle),
    realtime: z
      .object({
        maxSignalAgeMs: z
          .number()
          .int()
          .positive()
          .default(DEFAULT_ENTRY_POLICY.realtime.maxSignalAgeMs),
        minSwaps: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_ENTRY_POLICY.realtime.minSwaps),
        minDistinctSlots: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_ENTRY_POLICY.realtime.minDistinctSlots),
        maxRemoveMinusAdd: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_ENTRY_POLICY.realtime.maxRemoveMinusAdd),
        eventLimit: z.number().int().positive().optional(),
      })
      .default(DEFAULT_ENTRY_POLICY.realtime),
    freshness: z
      .object({
        maxSnapshotAgeMs: z
          .number()
          .int()
          .positive()
          .default(DEFAULT_ENTRY_POLICY.freshness.maxSnapshotAgeMs),
        maxActiveBinDriftBins: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_ENTRY_POLICY.freshness.maxActiveBinDriftBins),
        maxPriceMovePct: z
          .number()
          .min(0)
          .default(DEFAULT_ENTRY_POLICY.freshness.maxPriceMovePct),
      })
      .default(DEFAULT_ENTRY_POLICY.freshness),
    collapseGuard: z
      .object({
        enabled: z
          .boolean()
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.enabled),
        mode: z
          .enum(["observe", "enforce"])
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.mode),
        requireRiskDataForEnter: z
          .boolean()
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.requireRiskDataForEnter),
        blockDevSoldAll: z
          .boolean()
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.blockDevSoldAll),
        priceVsAthPctMin: z
          .number()
          .min(0)
          .max(100)
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.priceVsAthPctMin),
        maxDevRugCount: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.maxDevRugCount),
        maxDevTokenCount: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.maxDevTokenCount),
        maxSniperPct: z
          .number()
          .min(0)
          .max(100)
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.maxSniperPct),
        blockRiskScore: z
          .number()
          .min(0)
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.blockRiskScore),
        reduceRiskScore: z
          .number()
          .min(0)
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.reduceRiskScore),
        reduceSizeMultiplier: z
          .number()
          .min(0)
          .max(1)
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.reduceSizeMultiplier),
        microStabilityDelayMs: z
          .number()
          .int()
          .min(0)
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.microStabilityDelayMs),
        microMaxActiveBinDriftBins: z
          .number()
          .int()
          .min(0)
          .default(
            DEFAULT_ENTRY_POLICY.collapseGuard.microMaxActiveBinDriftBins,
          ),
        microMaxPriceMovePct: z
          .number()
          .min(0)
          .default(DEFAULT_ENTRY_POLICY.collapseGuard.microMaxPriceMovePct),
      })
      .default(DEFAULT_ENTRY_POLICY.collapseGuard),
    scoringWeights: z
      .object({
        confidence: z.number().optional(),
        feeRatio: z.number().optional(),
        volumeRatio: z.number().optional(),
        swaps: z.number().optional(),
        liquidityAdds: z.number().optional(),
        volumeSpikes: z.number().optional(),
        liquidityRemoves: z.number().optional(),
        riskCount: z.number().optional(),
      })
      .optional(),
  })
  .default(DEFAULT_ENTRY_POLICY);

const PaperTradingConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    openOnDryRun: z.boolean().default(true),
    maxOpenPositions: z.number().int().positive().optional(),
    openMode: z.enum(["fresh_snapshot"]).default("fresh_snapshot"),
  })
  .default({
    enabled: true,
    openOnDryRun: true,
    openMode: "fresh_snapshot",
  });

const LearningConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(["shadow", "active"]).default("shadow"),
  horizonsMinutes: z
    .array(z.number().int().positive())
    .nonempty()
    .default([10, 30, 120, 360]),
  minEvidenceForScore: z.number().int().min(1).default(5),
  injectIntoManagerPrompt: z.boolean().default(false),
  recencyHalfLifeDays: z.number().positive().default(14),
  maxOutcomesPerCycle: z.number().int().positive().default(20),
  files: z
    .object({
      decisions: z.string().min(1).default("./data/learning-decisions.jsonl"),
      outcomes: z.string().min(1).default("./data/learning-outcomes.jsonl"),
      shadowScores: z.string().min(1).default("./data/shadow-scores.jsonl"),
      lessons: z.string().min(1).default("./data/learning-lessons.jsonl"),
      snapshot: z.string().min(1).default("./data/learning-snapshot.jsonl"),
      signalWeights: z.string().min(1).default("./data/signal-weights.json"),
    })
    .default({
      decisions: "./data/learning-decisions.jsonl",
      outcomes: "./data/learning-outcomes.jsonl",
      shadowScores: "./data/shadow-scores.jsonl",
      lessons: "./data/learning-lessons.jsonl",
      snapshot: "./data/learning-snapshot.jsonl",
      signalWeights: "./data/signal-weights.json",
    }),
  horizonWeights: z.record(z.number(), z.number()).optional(),
  shadow: z
    .object({
      enterThreshold: z.number().optional(),
      skipThreshold: z.number().optional(),
    })
    .optional(),
  maxRiskFlags: z.number().int().min(1).optional(),
  signalWeightMinSamples: z.number().int().min(1).optional(),
  signalWeightMaxSignals: z.number().int().min(1).optional(),
  lessonRecencyDays: z.number().positive().optional(),
});

const PostCloseSwapConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    slippageBps: z.number().int().min(0).max(10_000).default(100),
    minSwapUsd: z.number().min(0).default(1),
    maxPriceImpactPct: z.number().min(0).default(10),
    priorityFeeLamports: z.number().int().min(0).optional(),
  })
  .default({
    enabled: false,
    slippageBps: 100,
    minSwapUsd: 1,
    maxPriceImpactPct: 10,
  });

// Phase 4.1 live-trading safety limits. These are HARD blocks enforced at the
// single live-open chokepoint (manager.open). Conservative ramp-up defaults;
// the operator widens them manually as live results prove out (see
// PRE-LIVE-CHECKLIST.md). Note: max OPEN positions is intentionally NOT here —
// it has a single source of truth in `manager.maxOpenPositions`.
const SafetyConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxSingleTradeUsd: z.number().positive().default(5),
    maxDailySpendUsd: z.number().positive().optional(),
    maxDailyTrades: z.number().int().positive().optional(),
    maxDailyLossUsd: z.number().positive().default(15),
    maxTotalDrawdownPct: z.number().min(0).max(1).default(0.1),
    startingCapitalUsd: z.number().positive().default(100),
    circuitBreaker: z
      .object({
        maxConsecutiveLosses: z.number().int().positive().default(3),
      })
      .default({ maxConsecutiveLosses: 3 }),
  })
  .default({
    enabled: true,
    maxSingleTradeUsd: 5,
    maxDailySpendUsd: undefined,
    maxDailyTrades: undefined,
    maxDailyLossUsd: 15,
    maxTotalDrawdownPct: 0.1,
    startingCapitalUsd: 100,
    circuitBreaker: { maxConsecutiveLosses: 3 },
  });

const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  journalFile: z.string().min(1).default("./data/decision-journal.jsonl"),
  injectIntoScreener: z.boolean().default(true),
  injectIntoManager: z.boolean().default(true),
  injectIntoPostMortem: z.boolean().default(true),
  recentLimit: z.number().int().min(0).default(8),
  maxPromptItems: z.number().int().min(0).default(6),
  includeLearningEvidence: z.boolean().default(true),
  minEvidenceForPrompt: z.number().int().min(1).default(5),
  poolMemoryFile: z.string().optional(),
  poolCooldownHours: z.number().min(0).optional(),
  minEvidenceNormScore: z.number().min(0).max(1).optional(),
  recencyBonusDays: z.number().positive().optional(),
});

const UserConfigSchema = z.object({
  rpc: z.object({
    url: z.string().min(1),
    wsUrl: z.string().min(1),
    commitment: z.enum(["processed", "confirmed", "finalized"]),
    fallbackUrls: z.array(z.string()).optional().default([]),
  }),
  meteora: z.object({
    programId: z.string().min(32),
    apiUrl: z.string().url(),
    timeframe: z.string().min(1).default("5m"),
    category: z.string().min(1).default("trending"),
    onchainConcurrency: z.number().int().positive().optional(),
    enrichConcurrency: z.number().int().positive().optional(),
    fetchLimit: z.number().int().positive().optional(),
  }),
  meteoraPnl: MeteoraPnlConfigSchema,
  lpagent: LpAgentConfigSchema.optional(),
  jupiter: z.object({
    baseUrl: z.string().url(),
    apiKey: z.string().optional(),
  }),
  okx: OkxConfigSchema,
  llm: z.object({
    provider: z.enum(["claude-cli", "mimo"]),
    model: z.string(),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().positive(),
    enabled: z.boolean(),
    baseUrl: z.string().url().optional(),
    binary: z.string().optional(),
    maxCallsPerScreenCycle: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
    managerMaxTokens: z.number().int().positive().optional(),
    postMortemMaxTokens: z.number().int().positive().optional(),
  }),
  scheduler: z.object({
    screenCron: z.string().min(1),
    screeningIntervalMin: z.number().int().positive().optional(),
    enabled: z.boolean(),
  }),
  entryPolicy: EntryPolicyConfigSchema,
  paperTrading: PaperTradingConfigSchema,
  filters: HardFiltersSchema,
  output: z.object({
    decisionLogPath: z.string().min(1),
    verbose: z.boolean(),
    /**
     * Directory where compact history streams/state are written for the web
     * bridge (candidates.jsonl, llm-runs.jsonl, progress.jsonl, positions.json,
     * realtime-signals.json). High-volume realtime signals are kept as a
     * bounded snapshot, not append-only history. Defaults to "./data".
     */
    dataDir: z.string().min(1).default("./data"),
  }),
  dryRun: z.boolean(),
  websocket: z.object({
    reconnectMaxAttempts: z.number().int().positive(),
    reconnectBaseDelayMs: z.number().int().positive(),
    reconnectMaxDelayMs: z.number().int().positive(),
    globalBufferSize: z.number().int().positive().optional(),
    perPoolBufferSize: z.number().int().positive().optional(),
    signatureBufferSize: z.number().int().positive().optional(),
    spikeWindowMs: z.number().int().positive().optional(),
    spikeThreshold: z.number().int().positive().optional(),
    spikeThrottleMs: z.number().int().positive().optional(),
  }),
  manager: z.object({
    enabled: z.boolean(),
    cron: z.string().min(1),
    managementIntervalMin: z.number().int().positive().optional(),
    useLlm: z.boolean(),
    maxOpenPositions: z.number().int().positive(),
    thresholds: z.object({
      claimMinUsd: z.number().min(0),
      outOfRangeMaxMinutes: z.number().min(0),
      stopLossPct: z.number().optional(),
      maxIlUsd: z.number().min(0),
      minTimeBeforeRebalanceMinutes: z.number().min(0),
      maxPositionAgeMinutes: z.number().min(1).optional(),
      takeProfitPct: z.number().min(0).optional(),
      trailingTakeProfit: z.boolean().optional(),
      trailingTriggerPct: z.number().min(0).optional(),
      trailingDropPct: z.number().min(0).optional(),
      minFeePerTvl24h: z.number().min(0).optional(),
      minAgeBeforeYieldCheck: z.number().min(0).optional(),
      outOfRangeBinsToClose: z.number().int().min(0).optional(),
      minInRangePctForOorClose: z.number().min(0).max(1).optional(),
      llmConfidenceThreshold: z.number().min(0).max(1).optional(),
      fallbackRebalanceRangeBps: z.number().int().positive().optional(),
    }),
    positionsFile: z.string().min(1),
    closedPositionsFile: z.string().min(1),
    lessonsFile: z.string().min(1),
    lessonsContextLimit: z.number().int().min(0),
    positionSizeUsd: z.number().positive().optional(),
    deployAmountSol: z.number().positive().optional(),
    positionSizePct: z.number().min(0).max(1).optional(),
    maxDeployAmount: z.number().positive().optional(),
    gasReserve: z.number().min(0).optional(),
    minSolToOpen: z.number().min(0).optional(),
    defaultRangeBps: z.number().int().positive().optional(),
    maxBinsPerSide: z.number().int().positive().optional(),
    autoCleanupEmpty: z.boolean().optional(),
    riskWatcherIntervalSec: z.number().int().positive().optional(),
    riskWatcherEnabled: z.boolean().optional(),
    trailingTpDebounceMs: z.number().int().min(0).optional(),
    fallbackSizeUsd: z.number().positive().optional(),
    samplingWindowMinutes: z.number().int().positive().optional(),
    strategyAutomation: z
      .object({
        autoCompound: z.boolean().optional(),
        compoundMinUsd: z.number().min(0).optional(),
        autoReseed: z.boolean().optional(),
        reseedMinPnlPct: z.number().optional(),
        autoHarvest: z.boolean().optional(),
        harvestMinUsd: z.number().min(0).optional(),
      })
      .optional(),
    postCloseSwap: PostCloseSwapConfigSchema,
    realtimeRebalance: z
      .object({
        enabled: z.boolean().default(false),
        throttleMs: z.number().int().positive().default(10_000),
        triggerOnSwap: z.boolean().default(true),
        triggerOnBinChange: z.boolean().default(true),
      })
      .optional(),
  }),
  capital: z.object({
    enabled: z.boolean(),
    minReserveSol: z.number().min(0),
    targetUsdcFraction: z.number().min(0).max(1),
    rebalanceThresholdPct: z.number().min(0).max(100),
    usdcMint: z.string().min(32),
    slippageBps: z.number().int().min(0).max(10_000),
  }),
  learning: LearningConfigSchema.default({
    enabled: true,
    mode: "shadow",
    horizonsMinutes: [10, 30, 120, 360],
    minEvidenceForScore: 5,
    injectIntoManagerPrompt: false,
    recencyHalfLifeDays: 14,
    maxOutcomesPerCycle: 20,
    files: {
      decisions: "./data/learning-decisions.jsonl",
      outcomes: "./data/learning-outcomes.jsonl",
      shadowScores: "./data/shadow-scores.jsonl",
      lessons: "./data/learning-lessons.jsonl",
      snapshot: "./data/learning-snapshot.jsonl",
      signalWeights: "./data/signal-weights.json",
    },
  }),
  research: z
    .object({
      defaultPool: z.string().optional(),
      defaultToken: z.string().optional(),
    })
    .optional(),
  safety: SafetyConfigSchema,
  memory: MemoryConfigSchema.default({
    enabled: true,
    journalFile: "./data/decision-journal.jsonl",
    injectIntoScreener: true,
    injectIntoManager: true,
    injectIntoPostMortem: true,
    recentLimit: 8,
    maxPromptItems: 6,
    includeLearningEvidence: true,
    minEvidenceForPrompt: 5,
  }),
});

function resolveDefaultConfigPath(): string {
  const candidates = [
    path.resolve(__dirname, "user-config.json"),
    path.resolve(__dirname, "../../src/config/user-config.json"),
    path.resolve(process.cwd(), "src/config/user-config.json"),
  ];
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!
  );
}

const DEFAULT_CONFIG_PATH = resolveDefaultConfigPath();

function expandEnv(value: string): string {
  return value.replace(
    /\$\{([A-Z0-9_]+)\}/gi,
    (_match, key: string) => process.env[key] ?? "",
  );
}

function deepExpand<T>(input: T): T {
  if (typeof input === "string") return expandEnv(input) as unknown as T;
  if (Array.isArray(input))
    return input.map((item) => deepExpand(item)) as unknown as T;
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = deepExpand(v);
    }
    return out as T;
  }
  return input;
}

function intervalMinutesToCron(minutes: number, field: string): string {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(
      `[config] ${field} must be a positive integer minute value`,
    );
  }
  if (minutes < 60) {
    if (60 % minutes !== 0) {
      throw new Error(
        `[config] ${field}=${minutes} cannot be represented as a stable minute cron interval; use a divisor of 60`,
      );
    }
    return `*/${minutes} * * * *`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    if (hours >= 1 && hours <= 23 && 24 % hours === 0) {
      return `0 */${hours} * * *`;
    }
    if (hours === 24) return "0 0 * * *";
  }
  throw new Error(
    `[config] ${field}=${minutes} cannot be represented as a simple cron interval`,
  );
}

function applyIntervalCronFields(config: UserConfig): void {
  if (typeof config.scheduler.screeningIntervalMin === "number") {
    config.scheduler.screenCron = intervalMinutesToCron(
      config.scheduler.screeningIntervalMin,
      "scheduler.screeningIntervalMin",
    );
  }
  if (typeof config.manager.managementIntervalMin === "number") {
    config.manager.cron = intervalMinutesToCron(
      config.manager.managementIntervalMin,
      "manager.managementIntervalMin",
    );
  }
}

export function loadConfig(overridePath?: string): UserConfig {
  const file = overridePath ?? DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(file)) {
    throw new Error(`Config file not found: ${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
  const expanded = deepExpand(raw);
  const parsed = UserConfigSchema.parse(expanded);
  applyIntervalCronFields(parsed);
  parsed.paperTrading.maxOpenPositions ??= parsed.manager.maxOpenPositions;

  // dryRun has a SINGLE source of truth: user-config.json `dryRun`.
  // The legacy DRY_RUN env override (.env / shell) was removed to avoid
  // 3-way ambiguity between shell env, .env, and user-config.json.

  // Sanity gate: shadow learning mode cannot run with live trading enabled.
  // This prevents a misconfiguration where the operator believes they are
  // observing but the bot is actually deploying real capital.
  if (
    parsed.learning.enabled &&
    parsed.learning.mode === "shadow" &&
    !parsed.dryRun
  ) {
    throw new Error(
      `[config] REFUSING TO START: learning.mode="shadow" expects dryRun=true, but resolved dryRun=false. ` +
        `Either set learning.mode="active" OR set dryRun=true (in user-config.json AND clear DRY_RUN env override).`,
    );
  }
  // LLM_PROVIDER env var allows switching provider at runtime without editing
  // user-config.json. Set LLM_PROVIDER=mimo in .env to use the HTTP provider,
  // or LLM_PROVIDER=claude-cli to force the local binary provider.
  const providerOverride = process.env.LLM_PROVIDER;
  if (providerOverride === "claude-cli" || providerOverride === "mimo") {
    parsed.llm.provider = providerOverride;
  } else if (providerOverride) {
    throw new Error(
      `[config] Invalid LLM_PROVIDER="${providerOverride}". Valid values: claude-cli, mimo`,
    );
  }

  // LLM model override applies only to the HTTP provider. The claude-cli
  // provider always uses `llm.model` from user-config.json (a claude alias like
  // "sonnet") so provider-specific model ids do not leak into the CLI.
  if (parsed.llm.provider === "mimo") {
    const modelOverride = process.env.MIMO_MODEL ?? process.env.LLM_MODEL;
    if (modelOverride) {
      parsed.llm.model = modelOverride;
    }
    if (process.env.MIMO_BASE_URL) {
      parsed.llm.baseUrl = process.env.MIMO_BASE_URL;
    }
  }
  if (process.env.HELIUS_RPC_URL) {
    parsed.rpc.url = process.env.HELIUS_RPC_URL;
  }
  if (process.env.HELIUS_WS_URL) {
    parsed.rpc.wsUrl = process.env.HELIUS_WS_URL;
  }
  return parsed;
}

export function configPath(): string {
  return DEFAULT_CONFIG_PATH;
}

export function getMimoApiKey(): string {
  const key = process.env.MIMO_API_KEY ?? readMimoMdValue("API_KEY");
  if (!key) {
    throw new Error(
      "MIMO_API_KEY is not set and API_KEY was not found in mimo.md.",
    );
  }
  return key;
}

export function getMimoBaseUrl(configBaseUrl?: string): string {
  return (
    process.env.MIMO_BASE_URL ??
    configBaseUrl ??
    readMimoOpenAiBaseUrl() ??
    "https://token-plan-sgp.xiaomimimo.com/v1"
  );
}

function readMimoMd(): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), "mimo.md"),
    path.resolve(__dirname, "../../mimo.md"),
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

function readMimoMdValue(key: string): string | undefined {
  const raw = readMimoMd();
  const match = raw?.match(new RegExp(`^${key}\\s*=\\s*(\\S+)`, "m"));
  return match?.[1];
}

function readMimoOpenAiBaseUrl(): string | undefined {
  const raw = readMimoMd();
  const marker = "Compatible with OpenAI API protocol:";
  const index = raw?.indexOf(marker) ?? -1;
  if (!raw || index < 0) return undefined;
  const tail = raw.slice(index + marker.length);
  return tail.match(/https?:\/\/\S+/)?.[0];
}

export function getHeliusApiKey(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("HELIUS_API_KEY is not set. Add it to .env.");
  return key;
}

/**
 * Base58-encoded Solana secret key for the bot wallet.
 *
 * WALLET_PRIVATE_KEY is the preferred name. PRIVATE_KEY_BOT remains supported
 * for existing installs and older docs/scripts.
 */
export function getWalletPrivateKey(): string | undefined {
  return cleanEnv(
    process.env.WALLET_PRIVATE_KEY ?? process.env.PRIVATE_KEY_BOT,
  );
}

/** Optional OKX Web3 API key. Public enrichment works without it. */
export function getOkxApiKey(): string | undefined {
  return cleanEnv(process.env.OKX_API_KEY ?? process.env.OK_ACCESS_KEY);
}

/** Optional OKX signed-auth secret key. Public enrichment works without it. */
export function getOkxSecretKey(): string | undefined {
  return cleanEnv(process.env.OKX_SECRET_KEY ?? process.env.OK_ACCESS_SECRET);
}

/** Optional OKX signed-auth passphrase. Public enrichment works without it. */
export function getOkxPassphrase(): string | undefined {
  return cleanEnv(
    process.env.OKX_PASSPHRASE ??
      process.env.OKX_API_PASSPHRASE ??
      process.env.OK_ACCESS_PASSPHRASE,
  );
}

/** Optional OKX project id for signed Web3 API requests. */
export function getOkxProjectId(): string | undefined {
  return cleanEnv(process.env.OKX_PROJECT_ID ?? process.env.OK_ACCESS_PROJECT);
}

export interface TelegramEnvConfig {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  dashboardUrl?: string;
}

/** Telegram bot notification config. Supports CHAT_ID as a short alias. */
export function getTelegramConfigFromEnv(): TelegramEnvConfig {
  const explicit = cleanEnv(process.env.TELEGRAM_ENABLED);
  const botToken = cleanEnv(process.env.TELEGRAM_BOT_TOKEN);
  const chatId = cleanEnv(process.env.TELEGRAM_CHAT_ID ?? process.env.CHAT_ID);
  const dashboardUrl = cleanEnv(process.env.TELEGRAM_DASHBOARD_URL);
  const enabled =
    explicit === undefined
      ? Boolean(botToken && chatId)
      : explicit.toLowerCase() !== "false";
  return {
    enabled,
    ...(botToken ? { botToken } : {}),
    ...(chatId ? { chatId } : {}),
    ...(dashboardUrl ? { dashboardUrl } : {}),
  };
}

function cleanEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
