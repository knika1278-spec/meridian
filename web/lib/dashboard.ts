// Slim payload shapes returned by /api/dashboard and consumed by the pages.

export interface JournalLite {
  id: string;
  ts: number;
  actor: string;
  event: string;
  status: string;
  summary: string;
  action?: string;
  poolName?: string;
}

export interface CandidateLite {
  address: string;
  name: string;
  status?: string;
  filtersPassed?: boolean;
  organicScore?: number;
  tvlUsd?: number;
  feeToTvlRatio?: number;
  action?: string;
  confidence?: number;
}

export interface LlmRunLite {
  ts: number;
  poolName: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd: number;
  action?: string;
  confidence?: number;
}

export interface PositionLite {
  positionPubkey: string;
  poolName?: string;
  tokens: string[];
  openedAt?: number;
  sizeUsd?: number;
  inRangePct?: number;
  pnlUsd?: number;
  status?: string;
  claimableFeesUsd?: number;
  pnlPct?: number;
  ageMinutes?: number;
  outOfRangeMinutes?: number;
}

export interface PositionDetail {
  positionPubkey: string;
  poolAddress?: string;
  poolName?: string;
  tokenX?: { mint: string; symbol: string; decimals: number };
  tokenY?: { mint: string; symbol: string; decimals: number };
  binStep?: number;
  lowerBinId?: number;
  upperBinId?: number;
  entryActiveBinId?: number;
  entryPrice?: number;
  entryTimestamp?: number;
  entryValueUsd?: number;
  strategyType?: string;
  dryRun?: boolean;
  txSignature?: string;
  notes?: string;
  lastEvaluation?: {
    evaluatedAt?: number;
    currentActiveBinId?: number;
    inRange?: boolean;
    inRangePct?: number;
    outOfRangeMinutes?: number;
    currentPrice?: number;
    currentValueUsd?: number;
    claimableFees?: { tokenX?: string; tokenY?: string; usdValue?: number };
    pnlUsd?: number;
    pnlPct?: number;
    ilUsd?: number;
    ageMinutes?: number;
  };
}

export interface ClosedLite {
  positionPubkey: string;
  poolName?: string;
  closedAt?: number;
  exitReason?: string;
  pnlUsd?: number;
}

export interface ProgressLite {
  id: string;
  cycleId: string;
  source: string;
  phase: string;
  status: string;
  percent: number;
  message: string;
  updatedAt: number;
}

export interface ShadowLite {
  decisionId: string;
  poolName?: string;
  bucketKey: string;
  expectedScore: number;
  riskScore: number;
  sampleSize: number;
  confidence: number;
  ts: number;
  disagreement?: string;
}

export interface OutcomeLite {
  decisionId: string;
  poolName?: string;
  horizonMinutes: number;
  kind: string;
  netPnlRiskScore?: number;
  evaluatedAt: number;
}

export interface DecisionLite {
  id: string;
  ts: number;
  poolName: string;
  kind: string;
  action: string;
  confidence?: number;
}

export interface SignalFinding {
  signal: string;
  sampleSize: number;
  lift: number;
  confidence: number;
  avgWithSignal: number;
  avgWithoutSignal: number;
}

export interface LessonLite {
  id: string;
  ts: number;
  poolName?: string;
  ruleForFuture: string;
  tags: string[];
}

export interface LearningSnapshot {
  ts: number;
  counts: {
    decisions: number;
    outcomes: number;
    lessons: number;
    shadowScores: number;
  };
  pendingByHorizon: Record<string, number>;
}

export interface DashboardSnapshot {
  generatedAt: number;
  dataDir: string;
  warnings: string[];
  dryRun: boolean | null;
  overview: {
    openPositions: number;
    closedPositions: number;
    screeningCycles: number;
    lastCycle: { id: string; ts: number; passed: number; total: number } | null;
    decisionCounts: Record<string, number>;
    memory: {
      memories: number;
      linked: number;
      clusterOnly: number;
      isolated: number;
    };
    learning: LearningSnapshot | null;
    realtime: { events: number; lastTs: number | null };
    recentJournal: JournalLite[];
  };
  screening: {
    lastCycleId: string | null;
    candidates: CandidateLite[];
    llmRuns: LlmRunLite[];
    totals: {
      costUsd: number;
      calls: number;
      avgLatencyMs: number;
      byAction: Record<string, number>;
    };
  };
  positions: { open: PositionLite[]; closed: ClosedLite[] };
  management: {
    events: JournalLite[];
    progress: ProgressLite[];
    lessons: LessonLite[];
  };
  learning: {
    snapshot: LearningSnapshot | null;
    signalWeights: {
      topPositive: SignalFinding[];
      topNegative: SignalFinding[];
    } | null;
    disagreements: ShadowLite[];
    outcomes: OutcomeLite[];
    decisions: DecisionLite[];
  };
}
