export type DecisionAction = "ENTER" | "WATCH" | "SKIP";

export type RealtimeEventKind =
  | "new_pool"
  | "liquidity_add"
  | "liquidity_remove"
  | "swap"
  | "volume_spike"
  | "active_bin_change"
  | "unknown";

export interface TokenInfo {
  mint: string;
  symbol: string;
  name?: string;
  decimals: number;
  marketCap?: number;
  holders?: number;
  organicScore?: number;
  priceUsd?: number;
}

export interface Pool {
  address: string;
  name: string;
  baseMint: string;
  quoteMint: string;
  baseToken?: TokenInfo;
  quoteToken?: TokenInfo;
  binStep: number;
  tvlUsd: number;
  volume24hUsd?: number;
  feeBps?: number;
  feeApr?: number;
  feeToTvlRatio?: number;
  activeBin?: number;
  reservesBase?: number;
  reservesQuote?: number;
  createdAt?: number;
}

export interface RealtimeEvent {
  kind: RealtimeEventKind;
  poolAddress?: string;
  poolName?: string;
  signature?: string;
  slot?: number;
  timestamp: number;
  amountUsd?: number;
  metadata?: Record<string, unknown>;
}

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

export type CandidateStatus = "SCREENING" | "CANDIDATE" | "DECIDED";

export interface PoolCandidate {
  pool: Pool;
  status: CandidateStatus;
  filtersPassed: boolean;
  lastUpdated: number;
  decision?: LLMDecision;
  organicScore?: number;
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
  | "LESSON_MINED";

export interface DecisionJournalEntry {
  id: string;
  timestamp: number;
  actor: DecisionActor;
  event: DecisionEvent;
  subject: {
    poolAddress?: string;
    poolName?: string;
    positionPubkey?: string;
    tokenSymbols?: string[];
  };
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

export interface DashboardStats {
  poolsScanned24h: number;
  poolsScannedTrend: number[];
  activeCandidates: number;
  activeCandidatesDelta: number;
  decisionsMade: number;
  decisionsSplit: { enter: number; watch: number; skip: number };
  hitRatePct: number;
  connected: boolean;
  lastCycleAt: number;
}

export interface PoolTimeSeriesPoint {
  t: number;
  tvl: number;
  volume: number;
}

export interface PoolDetail {
  candidate: PoolCandidate;
  series: PoolTimeSeriesPoint[];
  events: RealtimeEvent[];
  decision?: LLMDecision;
}

export interface LLMRun {
  id: string;
  cycleId: string;
  timestamp: number;
  poolAddress: string;
  poolName: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd: number;
  decision: LLMDecision;
  reasoning: string;
  promptSummary: string;
}

export type PositionStatus = "OPEN" | "CLOSING" | "CLOSED";

export interface Position {
  id: string;
  poolAddress: string;
  poolName: string;
  baseSymbol: string;
  quoteSymbol: string;
  status: PositionStatus;
  sizeUsd: number;
  rangeBps: number;
  entryPrice: number;
  currentPrice: number;
  currentValueUsd: number;
  pnlUsd: number;
  pnlPct: number;
  feesEarnedUsd: number;
  inRange: boolean;
  dryRun: boolean;
  openedAt: number;
  closedAt?: number;
}

export interface PositionsSummary {
  openCount: number;
  totalDeployedUsd: number;
  totalCurrentUsd: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  totalFeesUsd: number;
  realized24hUsd: number;
}

interface DashboardTokenSource {
  mint: string;
  symbol: string;
  name?: string;
  decimals: number;
  marketCap?: number;
  holders?: number;
  organicScore?: number;
  priceUsd?: number;
}

interface DashboardPoolSource {
  address: string;
  name: string;
  tokenX: DashboardTokenSource;
  tokenY: DashboardTokenSource;
  binStep: number;
  baseFeeBps: number;
  tvl: number;
  activeTvl: number;
  volume24h: number;
  fees24h: number;
  activeBinId: number;
  feeApr24h?: number;
  createdAt?: number;
}

export interface DashboardCandidateSource {
  pool: DashboardPoolSource;
  filtersPassed: boolean;
  decision?: LLMDecision;
  timestamp: number;
}

function toDashboardToken(token: DashboardTokenSource): TokenInfo {
  return {
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    marketCap: token.marketCap,
    holders: token.holders,
    organicScore: token.organicScore,
    priceUsd: token.priceUsd,
  };
}

export function toDashboardPoolCandidate(
  result: DashboardCandidateSource,
): PoolCandidate {
  const pool = result.pool;
  const activeTvl = Math.max(pool.activeTvl ?? 0, 1);
  const fees24h = pool.fees24h ?? 0;
  const status: CandidateStatus = result.decision
    ? "DECIDED"
    : result.filtersPassed
      ? "CANDIDATE"
      : "SCREENING";
  const organicRaw =
    ((pool.tokenX.organicScore ?? 0) + (pool.tokenY.organicScore ?? 0)) / 2;
  const organicScore = organicRaw > 1 ? organicRaw / 100 : organicRaw;

  return {
    pool: {
      address: pool.address,
      name: pool.name,
      baseMint: pool.tokenX.mint,
      quoteMint: pool.tokenY.mint,
      baseToken: toDashboardToken(pool.tokenX),
      quoteToken: toDashboardToken(pool.tokenY),
      binStep: pool.binStep,
      tvlUsd: pool.tvl ?? 0,
      volume24hUsd: pool.volume24h,
      feeBps: pool.baseFeeBps,
      feeApr: pool.feeApr24h,
      feeToTvlRatio: fees24h / activeTvl,
      activeBin: pool.activeBinId,
      createdAt: pool.createdAt,
    },
    status,
    filtersPassed: result.filtersPassed,
    lastUpdated: result.timestamp,
    organicScore,
    decision: result.decision,
  };
}
