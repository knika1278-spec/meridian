export type Commitment = "processed" | "confirmed" | "finalized";

export interface TokenAuditInfo {
  isVerified?: boolean;
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  topHoldersPct?: number;
  tags?: string[];
  flags: string[];
}

export interface TokenLaunchpadInfo {
  launchpad?: string;
  graduated?: boolean;
  graduatedAt?: number;
}

export interface TokenPriceStats {
  priceUsd?: number;
  liquidity?: number;
  priceChange24h?: number;
  priceChange1h?: number;
  priceChange5m?: number;
}

export interface SmartMoneyFlow {
  /** True when OKX enrichment returned any smart-money/cluster data. */
  available?: boolean;
  source?: string;
  netFlowUsd?: number;
  buyersCount?: number;
  sellersCount?: number;
  lastSignalsCount: number;
  smartMoneyBuy?: boolean;
  kolInClusters?: boolean;
  topClusterTrend?: string;
  topClusterHoldPct?: number;
}

export interface TokenRiskSummary {
  /** True when OKX enrichment returned any risk/advanced/price data. */
  available?: boolean;
  source?: string;
  riskLevel?: string;
  riskScore?: number;
  flags: string[];
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  topHoldersPct?: number;
  bundlePct?: number;
  sniperPct?: number;
  suspiciousPct?: number;
  devHoldingPct?: number;
  lpBurnedPct?: number;
  totalFeeSol?: number;
  devRugCount?: number;
  devTokenCount?: number;
  creator?: string;
  tags?: string[];
  isHoneypot?: boolean;
  isRugpull?: boolean;
  isWash?: boolean;
  smartMoneyBuy?: boolean;
  devSoldAll?: boolean;
  devBuyingMore?: boolean;
  lowLiquidity?: boolean;
  dexBoost?: boolean;
  dexScreenerPaid?: boolean;
  priceVsAthPct?: number;
  ath?: number;
}

export interface TokenInfo {
  mint: string;
  symbol: string;
  name?: string;
  decimals: number;
  marketCap?: number;
  fdv?: number;
  holders?: number;
  organicScore?: number;
  priceUsd?: number;
  /** Jupiter-derived audit data. */
  audit?: TokenAuditInfo;
  /** Jupiter-derived launchpad metadata. */
  launchpad?: TokenLaunchpadInfo;
  /** Jupiter-derived price stats (priceChange24h, liquidity). */
  priceStats?: TokenPriceStats;
  /** OKX-derived smart-money flow summary. */
  smartMoney?: SmartMoneyFlow;
  /** OKX-derived risk summary. */
  risk?: TokenRiskSummary;
}

export interface Pool {
  address: string;
  name: string;
  tokenX: TokenInfo;
  tokenY: TokenInfo;
  binStep: number;
  baseFeeBps: number;
  tvl: number;
  activeTvl: number;
  /** Legacy name: screening candidates store the active timeframe window here. */
  volume24h: number;
  /** Legacy name: screening candidates store the active timeframe window here. */
  fees24h: number;
  activeBinId: number;
  currentPrice: number;
  feeApr24h?: number;
  feeAprActive24h?: number;
  totalApr24h?: number;
  protocolFeeBps?: number;
  createdAt?: number;
  raw?: unknown;
}

export interface HardFilters {
  /** Percentage points per timeframe window, e.g. 0.05 = 0.05%. */
  feeActiveTvlRatioMin: number;
  organicScoreMin: number;
  holdersMin: number;
  marketCapMin: number;
  marketCapMax: number;
  binStepMin: number;
  binStepMax: number;
  tvlMin: number;
  tvlMax: number;
  /** Legacy name: minimum volume in the configured screening timeframe window. */
  volume24hMin?: number;
  excludedTokens?: string[];
  /** When set, pool passes when EXACTLY ONE token (XOR) is in this list.
   *  E.g. [SOL, USDC] surfaces RICH/SOL, HYPE/USDC, BONK/SOL, WIF/USDC —
   *  but REJECTS SOL-USDC (both in list, no memecoin side). */
  includedTokens?: string[];
  /** Maximum allowed OKX risk score (higher = riskier). */
  okxRiskScoreMax?: number;
  /** Minimum all-time token fees in SOL from OKX advanced-info. */
  minTokenFeesSol?: number;
  /** Maximum bundled holder percentage from OKX advanced-info. */
  maxBundlersPct?: number;
  /** Maximum top-10 holder concentration percentage from OKX advanced-info. */
  maxTop10Pct?: number;
  /** Launchpad names that should never be deployed into. */
  blockedLaunchpads?: string[];
  /** Required minimum smart-money net flow (USD) per token. */
  smartMoneyNetFlowUsdMin?: number;
  /** Reject tokens whose mint authority is still active. */
  requireMintAuthorityDisabled?: boolean;
  /** Reject tokens whose freeze authority is still active. */
  requireFreezeAuthorityDisabled?: boolean;
  /** Path to token blacklist JSON (relative to cwd or absolute). */
  blacklistFile?: string;
  /** Hard-reject pools with zero recent on-chain activity (no swap/liquidity
   *  events in the Helius WS buffer). Guards against dead/illiquid pools that
   *  pass fee-ratio filters on stale 5m candles. Only effective when the
   *  realtime WS listener is running; disable if running without --realtime. */
  requireRecentActivity?: boolean;
}

export type EntryPolicyMode = "observe" | "enforce";

export interface EntryPolicyRealtimeConfig {
  maxSignalAgeMs: number;
  minSwaps: number;
  minDistinctSlots: number;
  maxRemoveMinusAdd: number;
  /** Max realtime events to include per candidate (default 20). */
  eventLimit?: number;
  /** Number of time buckets to split the signal window into for trend analysis (default 6). */
  trendBuckets?: number;
  /** Minimum fraction of buckets that must contain at least one swap, 0-1 (default 0.5). */
  minSustainedRatio?: number;
  /** Max fraction of swaps allowed in the earliest third of the window, 0-1 (default 0.7). */
  maxBurstConcentration?: number;
}

export interface EntryPolicyFreshnessConfig {
  maxSnapshotAgeMs: number;
  maxActiveBinDriftBins: number;
  maxPriceMovePct: number;
}

export interface EntryPolicyCollapseGuardConfig {
  enabled: boolean;
  mode: EntryPolicyMode;
  requireRiskDataForEnter: boolean;
  blockDevSoldAll: boolean;
  priceVsAthPctMin: number;
  maxDevRugCount: number;
  maxDevTokenCount: number;
  maxSniperPct: number;
  /** Graduated risk score (inclusive) at or above which a candidate is BLOCKED. */
  blockRiskScore: number;
  /** Graduated risk score (inclusive) at or above which size is reduced (but not blocked). */
  reduceRiskScore: number;
  /** Size multiplier (0..1) applied when the guard returns REDUCE_SIZE. */
  reduceSizeMultiplier: number;
  microStabilityDelayMs: number;
  microMaxActiveBinDriftBins: number;
  microMaxPriceMovePct: number;
}

export interface EntryPolicyScoringWeights {
  confidence?: number;
  feeRatio?: number;
  volumeRatio?: number;
  swaps?: number;
  liquidityAdds?: number;
  volumeSpikes?: number;
  liquidityRemoves?: number;
  riskCount?: number;
}

export interface EntryPolicyConfig {
  enabled: boolean;
  mode: EntryPolicyMode;
  maxLlmCandidates: number;
  maxDeploysPerCycle: number;
  realtime: EntryPolicyRealtimeConfig;
  freshness: EntryPolicyFreshnessConfig;
  collapseGuard: EntryPolicyCollapseGuardConfig;
  /** Scoring weights for candidate ranking. */
  scoringWeights?: EntryPolicyScoringWeights;
}

export type PaperTradingOpenMode = "fresh_snapshot";

export interface PaperTradingConfig {
  enabled: boolean;
  openOnDryRun: boolean;
  maxOpenPositions?: number;
  openMode: PaperTradingOpenMode;
}

export interface RpcConfig {
  url: string;
  wsUrl: string;
  commitment: Commitment;
}

export type LLMProviderName = "claude-cli" | "mimo";

export interface LLMConfig {
  provider: LLMProviderName;
  model: string;
  temperature: number;
  maxTokens: number;
  enabled: boolean;
  /** OpenAI-compatible HTTP provider base URL. */
  baseUrl?: string;
  /** Claude CLI binary name or absolute path. */
  binary?: string;
  /** Cap LLM calls per screen cycle (default unlimited). Cost + latency control. */
  maxCallsPerScreenCycle?: number;
  /** LLM request timeout in milliseconds (default 180000). */
  timeoutMs?: number;
  /** Max concurrent LLM calls per cycle (default 3). */
  concurrency?: number;
  /** Max tokens for manager LLM calls (default 600). */
  managerMaxTokens?: number;
  /** Max tokens for post-mortem LLM calls (default 500). */
  postMortemMaxTokens?: number;
}

export interface SchedulerConfig {
  screenCron: string;
  /** Convenience interval. When set, config loading derives screenCron from it. */
  screeningIntervalMin?: number;
  enabled: boolean;
}

export interface OutputConfig {
  decisionLogPath: string;
  verbose: boolean;
  /**
   * Directory where the agent writes compact JSONL streams, bounded snapshots,
   * and canonical JSON state for the web bridge. Defaults to "./data".
   */
  dataDir: string;
}

export interface WebSocketConfig {
  reconnectMaxAttempts: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  /** Max events in the global rolling buffer (default 500). */
  globalBufferSize?: number;
  /** Max events per-pool buffer (default 50). */
  perPoolBufferSize?: number;
  /** Max unique signatures to track for dedup (default 1000). */
  signatureBufferSize?: number;
  /** Swap spike detection window in ms (default 60000). */
  spikeWindowMs?: number;
  /** Swap count threshold to trigger spike (default 5). */
  spikeThreshold?: number;
  /** Throttle between spike events in ms (default 60000). */
  spikeThrottleMs?: number;
}

export interface OkxConfig {
  /** Base URL for OKX Web3. Use https://web3.okx.com for public DEX enrichment. */
  baseUrl: string;
  /** Optional signed-auth key. Empty still allows public OKX enrichment. */
  apiKey?: string;
  /** Chain short name/index OKX uses for Solana (default "sol", public index 501). */
  chainShortName?: string;
  /** Set false to disable OKX entirely. When omitted/true, public enrichment is attempted. */
  enabled?: boolean;
}

export interface MeteoraPnlConfig {
  /** Base URL for Meteora's PnL API (e.g. https://dlmm-api.meteora.ag). */
  baseUrl: string;
  enabled?: boolean;
}

export interface LpAgentConfig {
  /** Base URL for LPAgent API (default https://api.lpagent.io). */
  baseUrl?: string;
  /** API key for LPAgent. */
  apiKey?: string;
  /** Enable LPAgent PnL tracking (default false). */
  enabled?: boolean;
  /** Poll interval in ms (default 10000 = 10s). */
  pollIntervalMs?: number;
}

export interface LearningFilesConfig {
  decisions: string;
  outcomes: string;
  shadowScores: string;
  lessons: string;
  snapshot: string;
  signalWeights: string;
}

export interface LearningConfig {
  enabled: boolean;
  mode: "shadow" | "active";
  /** Horizons (minutes) at which outcome labels are computed for each decision. */
  horizonsMinutes: number[];
  /** Minimum evidence rows in a bucket before ShadowRanker emits a score. */
  minEvidenceForScore: number;
  /** When true (v2+), shadow lessons are injected into manager prompt. v1 keeps this false. */
  injectIntoManagerPrompt: boolean;
  /** Recency half-life (days) for evidence weighting. */
  recencyHalfLifeDays: number;
  /** Cap on outcomes computed per cycle (bounds RPC + LLM cost). */
  maxOutcomesPerCycle: number;
  files: LearningFilesConfig;
  /** Horizon weights for evidence scoring (default: {10: 0.3, 30: 0.5, 120: 0.8, 360: 1.0}). */
  horizonWeights?: Record<number, number>;
  /** Shadow ranker disagreement thresholds. */
  shadow?: {
    enterThreshold?: number;
    skipThreshold?: number;
  };
  /** Max risk flags to record per decision (default 10). */
  maxRiskFlags?: number;
  /** Min samples for signal weight computation (default 5). */
  signalWeightMinSamples?: number;
  /** Max signals to emit (default 5). */
  signalWeightMaxSignals?: number;
  /** Lesson recency decay in days (default 30). */
  lessonRecencyDays?: number;
}

export interface MemoryConfig {
  enabled: boolean;
  journalFile: string;
  injectIntoScreener: boolean;
  injectIntoManager: boolean;
  injectIntoPostMortem: boolean;
  recentLimit: number;
  maxPromptItems: number;
  includeLearningEvidence: boolean;
  minEvidenceForPrompt: number;
  /** Path to pool-memory/cooldown JSON store. Default "data/pool-memory.json". */
  poolMemoryFile?: string;
  /** Hours a pool is on cooldown after a position is closed. Default 24. */
  poolCooldownHours?: number;
  /** Minimum normalized cohort score for evidence injection (default 0.7). */
  minEvidenceNormScore?: number;
  /** Recency bonus decay in days (default 15). */
  recencyBonusDays?: number;
}

export interface ResearchConfig {
  /** Default pool address used when running research CLI commands without --pool. */
  defaultPool?: string;
  /** Default token mint for research commands without --mint. */
  defaultToken?: string;
}

export interface SafetyCircuitBreakerConfig {
  /** Consecutive losing closes that trip the breaker into a halt. */
  maxConsecutiveLosses: number;
}

export interface SafetyConfig {
  /** Master switch. When false, live opens skip all safety-limit checks. */
  enabled: boolean;
  /** Hard cap on the USD size of a single live position open. */
  maxSingleTradeUsd: number;
  /** Max total USD deployed across all live opens in the current UTC day. */
  maxDailySpendUsd?: number;
  /** Max number of live opens in the current UTC day. */
  maxDailyTrades?: number;
  /** Halt new live opens once realized loss for the UTC day reaches this USD. */
  maxDailyLossUsd: number;
  /** Halt new live opens once equity drawdown from peak exceeds this fraction (0..1). */
  maxTotalDrawdownPct: number;
  /** Equity baseline (USD) used to compute drawdown: equity = baseline + cumulative realized PnL. */
  startingCapitalUsd: number;
  circuitBreaker: SafetyCircuitBreakerConfig;
}

export interface UserConfig {
  rpc: RpcConfig;
  meteora: {
    programId: string;
    apiUrl: string;
    timeframe: string;
    category: string;
    /** Max concurrent on-chain enrichment calls (default 3). */
    onchainConcurrency?: number;
    /** Max concurrent outer enrichment calls (default 15). */
    enrichConcurrency?: number;
    /** Default fetch limit for pool discovery (default 200). */
    fetchLimit?: number;
  };
  meteoraPnl: MeteoraPnlConfig;
  jupiter: { baseUrl: string; apiKey?: string };
  okx: OkxConfig;
  llm: LLMConfig;
  scheduler: SchedulerConfig;
  entryPolicy: EntryPolicyConfig;
  paperTrading: PaperTradingConfig;
  filters: HardFilters;
  output: OutputConfig;
  dryRun: boolean;
  websocket: WebSocketConfig;
  manager: ManagerConfig;
  capital: CapitalConfig;
  learning: LearningConfig;
  memory: MemoryConfig;
  research?: ResearchConfig;
  safety: SafetyConfig;
  lpagent?: LpAgentConfig;
}

export type RealtimeEventKind =
  | "new_pool"
  | "liquidity_add"
  | "liquidity_remove"
  | "swap"
  | "volume_spike"
  | "active_bin_change"
  | "unknown";

export interface RealtimeEvent {
  kind: RealtimeEventKind;
  poolAddress?: string;
  signature?: string;
  slot?: number;
  timestamp: number;
  amountUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface EntryRealtimeEvent {
  kind: RealtimeEventKind;
  poolAddress: string;
  signature?: string;
  slot?: number;
  timestamp: number;
  amountUsd?: number;
}

export interface RealtimeSignalSummary {
  total: number;
  swaps: number;
  liquidityAdds: number;
  liquidityRemoves: number;
  volumeSpikes: number;
  activeBinChanges: number;
  distinctSlots: number;
  latestSignalTimestamp?: number;
  latestSignalAgeMs?: number;
  /** Fraction of time buckets with at least one swap (0-1). */
  sustainedRatio?: number;
  /** Fraction of swaps concentrated in the earliest third of the window (0-1). */
  burstConcentration?: number;
  /** True if activity trend analysis flagged a burst pattern. */
  isBurst?: boolean;
}

export interface EntryPolicyResult {
  passed: boolean;
  reasonCode?: string;
  reasons: string[];
  risks: string[];
  realtime: RealtimeSignalSummary;
}

export interface EntrySnapshot {
  poolAddress: string;
  poolName: string;
  decisionTimestamp: number;
  activeBinId: number;
  currentPrice: number;
  binStep: number;
  tvl: number;
  activeTvl: number;
  volumeWindow: number;
  feesWindow: number;
  feeActiveTvlRatioPct: number;
  realtime: RealtimeSignalSummary;
  realtimeEvents?: EntryRealtimeEvent[];
  llmConfidence: number;
}

export type DecisionAction = "ENTER" | "WATCH" | "SKIP";

export interface LLMDecision {
  action: DecisionAction;
  confidence: number;
  reasons: string[];
  risks: string[];
  suggestedSizeUsd?: number;
  suggestedRangeBps?: number;
  notes?: string;
}

export type DeployGateAuditStatus =
  | "not_applicable"
  | "pending"
  | "blocked"
  | "would_open"
  | "queued"
  | "requested"
  | "opened"
  | "failed";

export interface DeployGateAudit {
  status: DeployGateAuditStatus;
  reason?: string;
  maxDeploysPerCycle?: number;
  timestamp?: number;
  sourceEvent?: DecisionEvent | "LLM_DECISION";
}

export interface FilterReportEntry {
  value: number | string | boolean | undefined;
  threshold?: number | string;
  passed: boolean;
}

export interface ScreeningResult {
  pool: Pool;
  filtersPassed: boolean;
  filterReport: Record<string, FilterReportEntry>;
  realtimeSignals: RealtimeEvent[];
  entryPolicy?: EntryPolicyResult;
  decision?: LLMDecision;
  deployGate?: DeployGateAudit;
  llmRaw?: string;
  timestamp: number;
  cycleId: string;
}

export interface DecisionLogEntry {
  cycleId: string;
  timestamp: number;
  pool: { address: string; name: string };
  filtersPassed: boolean;
  decision?: LLMDecision;
  deployGate?: DeployGateAudit;
  dryRun: boolean;
}

export interface ScreenerRunOptions {
  limit?: number;
  useLlm?: boolean;
  dryRunOverride?: boolean;
  commandId?: string;
}

// ============================================================
//  Runtime progress events
// ============================================================

export type ProgressSource =
  | "SCREENER"
  | "MANAGER"
  | "EXECUTOR"
  | "LEARNING"
  | "SYSTEM";

export type ProgressStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "skipped";

export interface BotProgressEvent {
  id: string;
  cycleId: string;
  source: ProgressSource;
  phase: string;
  status: ProgressStatus;
  percent: number;
  message: string;
  detail?: string;
  current?: number;
  total?: number;
  startedAt: number;
  updatedAt: number;
  etaMs?: number;
  commandId?: string;
  poolAddress?: string;
  poolName?: string;
  positionPubkey?: string;
}

// ============================================================
//  Position Manager types
// ============================================================

export interface ManagerThresholds {
  /** Claim fees only when claimable USD ≥ this (avoid wasting tx fees on dust). */
  claimMinUsd: number;
  /** Close position if active bin out-of-range for ≥ this many minutes. */
  outOfRangeMaxMinutes: number;
  /** Close position when PnL percentage is at or below this value, e.g. -15. */
  stopLossPct?: number;
  /** Close position if impermanent loss USD ≥ this. */
  maxIlUsd: number;
  /** Don't rebalance positions younger than this (avoid churn). */
  minTimeBeforeRebalanceMinutes: number;
  /** Close position when age exceeds this limit in minutes (hard ceiling). */
  maxPositionAgeMinutes?: number;
  /** Take profit at this PnL % (e.g. 5 = close when PnL ≥ +5%). */
  takeProfitPct?: number;
  /** Enable trailing take-profit: after TP triggered, lock in peak and trail down. */
  trailingTakeProfit?: boolean;
  /** PnL % that must be reached before trailing TP activates. */
  trailingTriggerPct?: number;
  /** Close when PnL drops this many % below peak (trailing stop). */
  trailingDropPct?: number;
  /**
   * Minimum fee-to-TVL yield rate (fee USD / position value USD * 100) per 24 h.
   * Close positions that earn below this rate after minAgeBeforeYieldCheck minutes.
   */
  minFeePerTvl24h?: number;
  /** Minutes a position must be open before yield-rate check applies. */
  minAgeBeforeYieldCheck?: number;
  /** Close when active bin is this many bins away from nearest range edge. */
  outOfRangeBinsToClose?: number;
  /** Minimum in-range % below which timed OOR triggers close (default 0.4). */
  minInRangePctForOorClose?: number;
  /** LLM confidence threshold for reconcile decisions (default 0.5). */
  llmConfidenceThreshold?: number;
  /** Fallback rangeBps when rebalance LLM returns 0/undefined (default 1000). */
  fallbackRebalanceRangeBps?: number;
}

export interface StrategyAutomationConfig {
  /** Auto-compound claimable fees back into the position. */
  autoCompound?: boolean;
  /** Minimum claimable USD before a compound is triggered. Default 1. */
  compoundMinUsd?: number;
  /** Auto-reseed: close and reopen at the current active bin with the same capital. */
  autoReseed?: boolean;
  /** Only reseed when PnL % is at or above this floor (avoid reseeding losers). */
  reseedMinPnlPct?: number;
  /** Auto-harvest: claim fees without closing the position. */
  autoHarvest?: boolean;
  /** Minimum claimable USD before a harvest is triggered. Default 0.5. */
  harvestMinUsd?: number;
}

export interface ManagerConfig {
  enabled: boolean;
  cron: string; // e.g. "*/5 * * * *"
  /** Convenience interval. When set, config loading derives cron from it. */
  managementIntervalMin?: number;
  useLlm: boolean;
  maxOpenPositions: number;
  thresholds: ManagerThresholds;
  positionsFile: string;
  closedPositionsFile: string;
  lessonsFile: string;
  /** How many past lessons to include in each Manager LLM call. */
  lessonsContextLimit: number;
  /** When set, ALWAYS use this USD value for new positions (caps LLM suggestion). */
  positionSizeUsd?: number;
  /** Base SOL to deploy per new position when positionSizeUsd is not set. */
  deployAmountSol?: number;
  /** Fraction of deployable SOL balance to use when below deployAmountSol. */
  positionSizePct?: number;
  /** Maximum SOL cap per new position. */
  maxDeployAmount?: number;
  /** Minimum SOL to keep in wallet for gas/rent. */
  gasReserve?: number;
  /** Minimum wallet SOL required before opening a position. */
  minSolToOpen?: number;
  /**
   * Default bin-range (basis points) when LLM doesn't suggest one, AND hard
   * cap on LLM's suggestion. Wider ranges trigger DLMM realloc errors at
   * Solana protocol limit (10,240 bytes per realloc) — keep ≤ 800 for safety.
   */
  defaultRangeBps?: number;
  /** Priority fee in lamports for open/rebalance transactions. */
  priorityFeeLamports?: number;
  /**
   * Hard cap on bin count per side, applied at open time. Prevents realloc
   * errors on narrow-bin-step pools (e.g. SOL-USDC bin 1 would otherwise
   * span 200 bins with rangeBps=400). Final width = min(rangeBps/binStep/2,
   * maxBinsPerSide). Default 30 keeps position account safely under the
   * 10,240-byte realloc limit.
   */
  maxBinsPerSide?: number;
  /**
   * Auto-close empty positions (entryAmountX=0 && entryAmountY=0) at bot
   * startup to reclaim ~0.057 SOL rent each. Default true. Disable only if
   * you want to manually inspect phantoms before reclaiming.
   */
  autoCleanupEmpty?: boolean;
  /** Lightweight deterministic close loop interval. Default 30 seconds. */
  riskWatcherIntervalSec?: number;
  /** Fallback USD size when LLM doesn't suggest one (default 200). */
  fallbackSizeUsd?: number;
  /** Sampling window in minutes for position in-range tracking (default 60). */
  samplingWindowMinutes?: number;
  /** Disable only for debugging; default true. */
  riskWatcherEnabled?: boolean;
  /**
   * Estimated number of active LP providers in the pool, used to approximate
   * this position's share of 24-hour fees. Default 50.
   */
  estimatedProviders?: number;
  /**
   * How long (ms) a take-profit condition must hold before the position is
   * closed. Prevents noise exits on momentary price spikes. Default 15_000.
   */
  trailingTpDebounceMs?: number;
  /** Strategy automation settings (compounding, reseed, harvest). */
  strategyAutomation?: StrategyAutomationConfig;
  /**
   * After a live DLMM close, swap non-SOL withdrawal proceeds back to SOL.
   * Disabled by default because it submits additional market-swap txs.
   */
  postCloseSwap?: PostCloseSwapConfig;
  /** Real-time rebalance trigger via WebSocket events. */
  realtimeRebalance?: RealtimeRebalanceConfig;
}

export interface PostCloseSwapConfig {
  enabled: boolean;
  /** Jupiter slippage in basis points. */
  slippageBps: number;
  /** Skip swaps whose quoted SOL output is worth less than this USD value. */
  minSwapUsd: number;
  /** Maximum allowed Jupiter price impact in percentage points. */
  maxPriceImpactPct: number;
  /** Optional priority fee passed through to Jupiter swap build. */
  priorityFeeLamports?: number;
}

/** Real-time rebalance trigger configuration. */
export interface RealtimeRebalanceConfig {
  /** Enable real-time rebalance trigger (default false). */
  enabled: boolean;
  /** Minimum ms between evaluations per pool (default 10000). */
  throttleMs?: number;
  /** Trigger on swap events (default true). */
  triggerOnSwap?: boolean;
  /** Trigger on active_bin_change events (default true). */
  triggerOnBinChange?: boolean;
}

/** Bot wallet capital balancing config (startup auto-swap). */
export interface CapitalConfig {
  enabled: boolean;
  /** Reserve SOL — never swap below this (gas + rent buffer). */
  minReserveSol: number;
  /** Target USDC fraction (0..1) of swappable capital after reserve. */
  targetUsdcFraction: number;
  /** Skip rebalance if drift is below this percent. */
  rebalanceThresholdPct: number;
  /** USDC mint (defaults to mainnet USDC). */
  usdcMint: string;
  /** Jupiter swap slippage in basis points. */
  slippageBps: number;
}

export type DlmmStrategy = "Spot" | "BidAsk" | "Curve";

export interface PositionToken {
  mint: string;
  symbol: string;
  decimals: number;
}

export interface Position {
  positionPubkey: string;
  poolAddress: string;
  poolName: string;
  tokenX: PositionToken;
  tokenY: PositionToken;
  binStep: number;
  lowerBinId: number;
  upperBinId: number;
  entryActiveBinId: number;
  entryPrice: number;
  entryTimestamp: number;
  entryAmountX: string; // raw u64 as string
  entryAmountY: string; // raw u64 as string
  entryValueUsd: number;
  strategyType: DlmmStrategy;
  cycleIdOnEnter?: string; // links back to ScreeningResult.cycleId
  entrySnapshot?: EntrySnapshot;
  dryRun: boolean;
  txSignature?: string;
  notes?: string;
  /**
   * Latest manager-side evaluation persisted with the canonical position state.
   * This keeps dashboard/Telegram reads accurate without a duplicate
   * append-only positions stream.
   */
  lastEvaluation?: PositionLastEvaluation;
  /**
   * Simulated position state maintained by SimulatedPositionEvaluator for
   * dry-run positions that were never submitted on-chain.
   */
  sim?: SimulatedPositionState;
  /**
   * Timestamp (ms) when a trailing take-profit condition was first observed.
   * Used for debounce logic — position only closes once the condition holds
   * for trailingTpDebounceMs continuously (default 15 s).
   */
  trailingTpConfirmAt?: number;
  /** Peak PnL % observed while the position was open (trailing-TP high watermark). */
  peakPnlPct?: number;
  /** True once the trailing-TP trigger threshold has been crossed at least once. */
  trailingTpActive?: boolean;
  /** Unix ms when the position first went out-of-range. Cleared on re-entry. */
  firstOutOfRangeAt?: number;
  /** Unix ms of the last fee-harvest (claim without close). */
  lastHarvestAt?: number;
  /** Unix ms of the last fee-compound (re-added to position). */
  lastCompoundAt?: number;
  /** Unix ms of the last reseed (close-and-reopen at active bin). */
  lastReseedAt?: number;
  /** DLMM position-layer ID for multi-layer positions. */
  layerId?: string;
  /** Pool-deploy cycle ID linking related open+close events for the same pool. */
  parentPoolDeployId?: string;
}

/** Live sim state for a dry-run position (never on-chain). */
export interface SimulatedPositionState {
  currentValueUsd: number;
  accruedFeesUsd: number;
  activeBinId: number;
  inRange: boolean;
  firstOutOfRangeAt?: number;
  lastUpdated: number; // epoch ms
}

export interface ClaimableFees {
  tokenX: string; // raw u64 as string
  tokenY: string; // raw u64 as string
  usdValue: number;
}

export interface PositionLastEvaluation {
  evaluatedAt: number;
  currentActiveBinId: number;
  inRange: boolean;
  inRangePct: number;
  outOfRangeMinutes: number;
  currentPrice: number;
  currentAmountX: string;
  currentAmountY: string;
  currentValueUsd: number;
  claimableFees: ClaimableFees;
  pnlUsd: number;
  pnlPct: number;
  ilUsd: number;
  ageMinutes: number;
  remoteMeteoraPnl?: RemoteMeteoraPnl;
}

/** Snapshot returned by Meteora's official PnL API for a position. */
export interface RemoteMeteoraPnl {
  positionAddress?: string;
  poolAddress?: string;
  totalFeeUsdClaimed: number;
  unclaimedFeeUsd: number;
  totalPnlUsd: number;
  realizedPnlUsd?: number;
  impermanentLossUsd: number;
  feeApr24h?: number;
  depositsUsd?: number;
  withdrawalsUsd?: number;
  lastUpdatedAt?: number;
}

export interface PositionEvaluation {
  position: Position;
  evaluatedAt: number;
  currentActiveBinId: number;
  inRange: boolean;
  /** Rolling fraction of recent samples spent in-range (0..1). */
  inRangePct: number;
  /** Number of consecutive minutes the position has been out-of-range, 0 if currently in. */
  outOfRangeMinutes: number;
  currentPrice: number;
  currentAmountX: string;
  currentAmountY: string;
  currentValueUsd: number;
  claimableFees: ClaimableFees;
  pnlUsd: number;
  pnlPct: number;
  ilUsd: number;
  ageMinutes: number;
  /** Authoritative PnL/fee numbers from Meteora's PnL API, if available. */
  remoteMeteoraPnl?: RemoteMeteoraPnl;
}

export type ManagerActionKind =
  | "hold"
  | "claim"
  | "close"
  | "rebalance"
  | "skip"
  | "error";

export interface ManagerAction {
  kind: ManagerActionKind;
  reason: string;
  confidence?: number;
  newRangeBps?: number; // only when kind = rebalance
  raw?: string; // raw LLM output for debugging
}

export interface ClosedPosition {
  position: Position;
  closedAt: number;
  exitReason: string;
  exitValueUsd: number;
  totalFeesUsdEarned: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  realizedIlUsd: number;
  ageMinutes: number;
  finalEvaluation: PositionEvaluation;
  closeTxSignature?: string;
  lessonId?: string;
}

export interface Lesson {
  id: string;
  timestamp: number;
  poolName: string;
  tags: string[];
  positiveTakeaway?: string | null;
  mistake?: string | null;
  ruleForFuture: string;
  context: { entry: string; exit: string; pnlUsd: number };
}

export interface BlacklistEntry {
  /** Token mint address. */
  mint: string;
  /** Human-readable symbol for display. */
  symbol: string;
  /** Unix ms when added. */
  addedAt: number;
  /** Free-text reason. */
  reason: string;
  /** Who added it: "bot" (auto from loss) or "user" (CLI/Telegram). */
  source: "bot" | "user";
}

export interface PoolMemoryEntry {
  /** Pool address. */
  poolAddress: string;
  /** Human-readable pool name for display. */
  poolName: string;
  /** Unix ms when the last position in this pool was closed. */
  lastClosedAt: number;
  /** Cooldown expiry (ms). Pool is filtered until this timestamp. */
  cooldownUntil: number;
  /** Exit reason of the triggering close. */
  exitReason: string;
  /** PnL % of the triggering position. */
  pnlPct: number;
  /** Optional operator note attached via CLI/Telegram. */
  note?: string;
}

export interface ManagerCycleActionRecord {
  positionPubkey: string;
  action: ManagerAction;
  success: boolean;
  error?: string;
}

export interface ManagerCycleReport {
  cycleId: string;
  timestamp: number;
  evaluations: PositionEvaluation[];
  actions: ManagerCycleActionRecord[];
  closedCount: number;
  claimedCount: number;
  rebalancedCount: number;
  lessonsLearned: number;
}

export interface OpenPositionInput {
  poolAddress: string;
  sizeUsd: number;
  rangeBps: number;
  strategy?: DlmmStrategy;
  dryRun?: boolean;
  paper?: boolean;
  cycleIdOnEnter?: string;
  entrySnapshot?: EntrySnapshot;
  notes?: string;
  priorityFeeLamports?: number;
}

export interface OpenPositionResult {
  position: Position;
  signature?: string;
  dryRun: boolean;
  liquidityAdded: boolean;
  error?: string;
}

// ============================================================
//  Learning loop types (v1: shadow mode — observation only)
// ============================================================

export type LearningDecisionKind = "screener" | "manager";

/** Classification of a token pair for cohort bucketing. */
export type PairClass = "stable" | "major" | "exotic" | "unknown";

/**
 * Snapshot of features used at decision time. Optional fields are populated
 * when available — recorder writes whatever it can extract from the upstream
 * Pool / PositionEvaluation.
 */
export interface LearningDecisionFeatures {
  binStep?: number;
  /** Screener-side: pool price captured at decision time. */
  entryPrice?: number;
  /** Suggested total range converted into approximate bins per side. */
  rangeBinsPerSide?: number;
  feeOverActiveTvl?: number;
  volumeOverTvl?: number;
  organicScore?: number;
  holders?: number;
  mcUsd?: number;
  tvlUsd?: number;
  activeBinId?: number;
  /** Derived from token symbols at recording time. */
  pairClass?: PairClass;
  /** Filter-failure tags or risk markers carried forward for the ranker. */
  riskFlags?: string[];
  /** Manager-side: in-range fraction at decision time. */
  inRangePct?: number;
  /** Manager-side: minutes the position has been out-of-range. */
  outOfRangeMinutes?: number;
  /** Manager-side: PnL snapshot in USD. */
  pnlUsd?: number;
  /** Manager-side: IL snapshot in USD. */
  ilUsd?: number;
  /** Manager-side: age in minutes. */
  ageMinutes?: number;
  /** Manager-side: claimable fees in USD. */
  claimableFeesUsd?: number;
  /** Lower bound of the position range (manager-side). */
  lowerBinId?: number;
  /** Upper bound of the position range (manager-side). */
  upperBinId?: number;
}

/** Combined action vocabulary across screener and manager. */
export type LearningActionAny =
  | "ENTER"
  | "WATCH"
  | "SKIP"
  | "HOLD"
  | "CLAIM"
  | "CLOSE"
  | "REBALANCE";

export interface LearningDecision {
  /** Deterministic ID — see learning/decision-id.ts. */
  id: string;
  kind: LearningDecisionKind;
  timestamp: number;
  /** Screener-side: cycleId from ScreeningResult. */
  cycleId?: string;
  pool: { address: string; name: string };
  /** Manager-side only: address of the on-chain position. */
  positionPubkey?: string;
  action: LearningActionAny;
  confidence?: number;
  reasons: string[];
  risks: string[];
  features: LearningDecisionFeatures;
  deployGate?: DeployGateAudit;
  /** Manager-side: trimmed PositionEvaluation snapshot. */
  evaluationSnapshot?: Record<string, unknown>;
  suggestedSizeUsd?: number;
  suggestedRangeBps?: number;
  /** Trimmed LLM raw response (first 500 chars). */
  llmRaw?: string;
}

export type LearningOutcomeKind = "entry_market_proxy" | "realized";

export interface LearningOutcome {
  decisionId: string;
  horizonMinutes: number;
  kind: LearningOutcomeKind;
  evaluatedAt: number;
  /** (currentMid - entryMid) / entryMid for entry_market_proxy. */
  priceReturn?: number;
  /** Delta-pct of fee/activeTVL since decision time. */
  feeActiveTvlChange?: number;
  /** Delta-pct of volume/TVL since decision time. */
  volumeTvlChange?: number;
  /** abs(currentActiveBinId - decision.features.activeBinId). */
  activeBinDrift?: number;
  riskFlagsTripped: string[];
  /** Realized side — populated when a closed position is available. */
  realizedPnlUsd?: number;
  realizedFeesUsd?: number;
  realizedIlUsd?: number;
  ageMinutes?: number;
  outOfRangeMinutes?: number;
  /** Drawdown fraction (positive number) relative to entry value. */
  drawdownPct?: number;
  /** PRIMARY LABEL — see learning/score-net-pnl-risk.ts. Range [-1, +1]. */
  netPnlRiskScore: number;
  /** Formula version — matches SCORE_VERSION from score-net-pnl-risk.ts. Absent on pre-v2 records. */
  scoreVersion?: number;
}

export interface ShadowEvidence {
  decisionId: string;
  score: number;
  summary: string;
}

export interface ShadowDisagreement {
  llmAction: LearningActionAny;
  shadowRecommendation: "favor" | "avoid";
  magnitude: number;
}

export interface ShadowScore {
  decisionId: string;
  generatedAt: number;
  bucketKey: string;
  expectedScore: number;
  riskScore: number;
  sampleSize: number;
  confidence: number;
  topEvidence: ShadowEvidence[];
  disagreement?: ShadowDisagreement;
}

export interface LessonApplicability {
  tags: string[];
  poolName?: string;
  binStepRange?: [number, number];
  feeTvlRange?: [number, number];
}

export interface LessonEvidence {
  lessonId: string;
  sampleSize: number;
  avgOutcome: number;
  bestExamples: string[];
  worstExamples: string[];
  applicability: LessonApplicability;
}

export interface LearningLesson extends Lesson {
  evidence: LessonEvidence;
  source: "closed_position" | "cohort";
}

export interface SignalWeightFinding {
  signal: string;
  sampleSize: number;
  lift: number;
  confidence: number;
  avgWithSignal: number;
  avgWithoutSignal: number;
}

export interface SignalWeightsSnapshot {
  generatedAt: number;
  sampleSize: number;
  minSamples: number;
  topPositive: SignalWeightFinding[];
  topNegative: SignalWeightFinding[];
}

// ============================================================
//  Decision Journal + prompt memory types
// ============================================================

export type DecisionActor = "SCREENER" | "EXECUTOR" | "MANAGER" | "LEARNING";

export type DecisionEvent =
  | "SCREEN_DECISION"
  | "NO_DEPLOY"
  | "WOULD_OPEN"
  | "OPEN_QUEUED"
  | "OPEN_SUCCESS"
  | "OPEN_FAILED"
  | "MANAGER_DECISION"
  | "ACTION_SUCCESS"
  | "ACTION_FAILED"
  | "SHADOW_DISAGREEMENT"
  | "LESSON_MINED"
  | "WALLET_BALANCE";

export interface DecisionJournalSubject {
  poolAddress?: string;
  poolName?: string;
  positionPubkey?: string;
  tokenSymbols?: string[];
}

export interface DecisionJournalEntry {
  id: string;
  timestamp: number;
  actor: DecisionActor;
  event: DecisionEvent;
  subject: DecisionJournalSubject;
  action?: string;
  status: "PROPOSED" | "SKIPPED" | "SUCCESS" | "FAILED" | "INFO";
  summary: string;
  reasons: string[];
  risks: string[];
  metrics: Record<string, string | number | boolean | null>;
  rejectedAlternatives: string[];
  linkedIds: Record<string, string | undefined>;
  dryRun: boolean;
  raw?: string;
}

export interface PromptMemoryItem {
  id: string;
  journalId?: string;
  lessonId?: string;
  evidenceId?: string;
  kind: "journal" | "lesson" | "learning_evidence";
  timestamp: number;
  summary: string;
  relevance: number;
  action?: string;
  status?: string;
  reasons?: string[];
  risks?: string[];
  metrics?: Record<string, string | number | boolean | null>;
}

export interface PromptMemoryBundle {
  recentDecisions: PromptMemoryItem[];
  lessons: PromptMemoryItem[];
  learningEvidence: PromptMemoryItem[];
}
