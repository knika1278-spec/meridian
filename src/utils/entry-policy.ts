import fs from "node:fs";
import type {
  EntryPolicyConfig,
  EntryPolicyResult,
  EntryRealtimeEvent,
  EntrySnapshot,
  HardFilters,
  LLMDecision,
  Pool,
  RealtimeEvent,
  RealtimeSignalSummary,
  ScreeningResult,
  UserConfig,
} from "../types/index.js";

export const DEFAULT_ENTRY_POLICY: EntryPolicyConfig = {
  enabled: true,
  mode: "observe",
  maxLlmCandidates: 6,
  maxDeploysPerCycle: 2,
  realtime: {
    maxSignalAgeMs: 180_000,
    minSwaps: 3,
    minDistinctSlots: 2,
    maxRemoveMinusAdd: 1,
    trendBuckets: 6,
    minSustainedRatio: 0.5,
    maxBurstConcentration: 0.7,
  },
  freshness: {
    maxSnapshotAgeMs: 60_000,
    maxActiveBinDriftBins: 2,
    maxPriceMovePct: 2.5,
  },
  collapseGuard: {
    enabled: true,
    mode: "enforce",
    requireRiskDataForEnter: false,
    blockDevSoldAll: false,
    priceVsAthPctMin: 50,
    maxDevRugCount: 1,
    maxDevTokenCount: 50,
    maxSniperPct: 5,
    blockRiskScore: 50,
    reduceRiskScore: 25,
    reduceSizeMultiplier: 0.5,
    microStabilityDelayMs: 2_500,
    microMaxActiveBinDriftBins: 2,
    microMaxPriceMovePct: 1.5,
  },
};

export type CollapseGuardAction = "allow" | "reduce_size" | "block";

export interface FreshEntryValidation {
  passed: boolean;
  reasonCode?: string;
  reasons: string[];
  risks: string[];
  metrics: Record<string, number | string | boolean | null>;
  /** Capital multiplier (0..1) the caller should apply to the open size. */
  sizeMultiplier: number;
}

export interface CollapseGuardResult {
  passed: boolean;
  /** Graduated decision: allow at full size, reduce size, or hard block. */
  action: CollapseGuardAction;
  /** Aggregate risk score (max across screened tokens). */
  riskScore: number;
  /** Capital multiplier (0..1): 1 for allow, reduceSizeMultiplier for reduce, 0 for block. */
  sizeMultiplier: number;
  reasonCode?: string;
  reasons: string[];
  risks: string[];
  metrics: Record<string, number | string | boolean | null>;
}

interface FreshEntryValidationInput {
  snapshot: EntrySnapshot;
  freshPool: Pool;
  freshEvents: RealtimeEvent[];
  freshRealtimeSource?: "listener" | "command_snapshot" | "snapshot_file";
  config: UserConfig;
  now?: number;
}

export interface DeployCandidateLike {
  pool: Pool;
  filtersPassed: boolean;
  realtimeSignals: RealtimeEvent[];
  entryPolicy?: EntryPolicyResult;
  decision?: Pick<LLMDecision, "action" | "confidence" | "risks">;
}

export function summarizeRealtimeSignals(
  events: RealtimeEvent[],
  now = Date.now(),
): RealtimeSignalSummary {
  const latest = events.reduce<number | undefined>((acc, event) => {
    if (!Number.isFinite(event.timestamp)) return acc;
    return acc === undefined ? event.timestamp : Math.max(acc, event.timestamp);
  }, undefined);
  const slots = new Set<number>();
  let swaps = 0;
  let liquidityAdds = 0;
  let liquidityRemoves = 0;
  let volumeSpikes = 0;
  let activeBinChanges = 0;

  for (const event of events) {
    if (typeof event.slot === "number" && Number.isFinite(event.slot)) {
      slots.add(event.slot);
    }
    switch (event.kind) {
      case "swap":
        swaps++;
        break;
      case "liquidity_add":
        liquidityAdds++;
        break;
      case "liquidity_remove":
        liquidityRemoves++;
        break;
      case "volume_spike":
        volumeSpikes++;
        break;
      case "active_bin_change":
        activeBinChanges++;
        break;
      default:
        break;
    }
  }

  return {
    total: events.length,
    swaps,
    liquidityAdds,
    liquidityRemoves,
    volumeSpikes,
    activeBinChanges,
    distinctSlots: slots.size,
    ...(latest !== undefined
      ? {
          latestSignalTimestamp: latest,
          latestSignalAgeMs: Math.max(0, now - latest),
        }
      : {}),
  };
}

export interface ActivityTrend {
  sustainedRatio: number;
  burstConcentration: number;
  isBurst: boolean;
}

/**
 * Analyze the temporal distribution of swap events to detect burst patterns.
 * Divides the event window into `bucketCount` equal time buckets and checks
 * whether activity is sustained or concentrated in a short burst.
 */
export function analyzeActivityTrend(
  events: RealtimeEvent[],
  bucketCount: number,
  now = Date.now(),
): ActivityTrend {
  const swapEvents = events
    .filter((e) => e.kind === "swap" && Number.isFinite(e.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  const totalSwaps = swapEvents.length;
  if (totalSwaps < 2 || bucketCount < 2) {
    return { sustainedRatio: 0, burstConcentration: 0, isBurst: false };
  }

  const earliest = swapEvents[0]!.timestamp;
  const latest = swapEvents[swapEvents.length - 1]!.timestamp;
  const windowMs = latest - earliest;

  // All events at the same instant — treat as burst.
  if (windowMs <= 0) {
    return { sustainedRatio: 0, burstConcentration: 1, isBurst: true };
  }

  const bucketSize = windowMs / bucketCount;
  const bucketCounts = new Array<number>(bucketCount).fill(0);

  for (const event of swapEvents) {
    const idx = Math.min(
      Math.floor((event.timestamp - earliest) / bucketSize),
      bucketCount - 1,
    );
    bucketCounts[idx] = (bucketCounts[idx] ?? 0) + 1;
  }

  const bucketsWithSwaps = bucketCounts.filter((c) => c > 0).length;
  const sustainedRatio = bucketsWithSwaps / bucketCount;

  // First third: buckets [0 .. ceil(bucketCount/3)-1]
  const firstThirdEnd = Math.ceil(bucketCount / 3);
  const swapsInFirstThird = bucketCounts
    .slice(0, firstThirdEnd)
    .reduce((sum, c) => sum + c, 0);
  const burstConcentration = swapsInFirstThird / totalSwaps;

  return {
    sustainedRatio,
    burstConcentration,
    isBurst: false, // caller decides the threshold
  };
}

export function evaluateEntryPolicy(
  events: RealtimeEvent[],
  policy: EntryPolicyConfig = DEFAULT_ENTRY_POLICY,
  now = Date.now(),
): EntryPolicyResult {
  if (!policy.enabled) {
    return {
      passed: true,
      reasons: ["entry policy disabled"],
      risks: [],
      realtime: summarizeRealtimeSignals(events, now),
    };
  }

  const realtime = summarizeRealtimeSignals(events, now);
  const reasons: string[] = [];
  const risks: string[] = [];
  let reasonCode: string | undefined;

  if (realtime.total === 0) {
    reasonCode ??= "entry_policy_failed";
    risks.push("no realtime signals for this pool");
  }
  if (
    realtime.latestSignalAgeMs === undefined ||
    realtime.latestSignalAgeMs > policy.realtime.maxSignalAgeMs
  ) {
    reasonCode ??= "stale_realtime";
    risks.push(
      `latest realtime signal age ${realtime.latestSignalAgeMs ?? "unavailable"}ms exceeds ${policy.realtime.maxSignalAgeMs}ms`,
    );
  }
  if (realtime.swaps < policy.realtime.minSwaps) {
    reasonCode ??= "entry_policy_failed";
    risks.push(
      `swap count ${realtime.swaps} below minimum ${policy.realtime.minSwaps}`,
    );
  }
  if (realtime.distinctSlots < policy.realtime.minDistinctSlots) {
    reasonCode ??= "entry_policy_failed";
    risks.push(
      `distinct realtime slots ${realtime.distinctSlots} below minimum ${policy.realtime.minDistinctSlots}`,
    );
  }
  const removeMinusAdd = realtime.liquidityRemoves - realtime.liquidityAdds;
  if (removeMinusAdd > policy.realtime.maxRemoveMinusAdd) {
    reasonCode ??= "entry_policy_failed";
    risks.push(
      `liquidity_remove minus liquidity_add ${removeMinusAdd} exceeds ${policy.realtime.maxRemoveMinusAdd}`,
    );
  }

  // Activity trend analysis — detect burst patterns and unsustained activity.
  // Trend risks are additive; they don't override reasonCode from existing checks
  // so that more specific codes (stale_realtime, entry_policy_failed) take priority.
  const trendBuckets = policy.realtime.trendBuckets;
  if (trendBuckets !== undefined && trendBuckets >= 2 && realtime.swaps >= 2) {
    const trend = analyzeActivityTrend(events, trendBuckets, now);
    realtime.sustainedRatio = trend.sustainedRatio;
    realtime.burstConcentration = trend.burstConcentration;

    const maxBurst = policy.realtime.maxBurstConcentration ?? 0.7;
    realtime.isBurst = trend.burstConcentration > maxBurst;
    if (realtime.isBurst) {
      reasonCode ??= "activity_burst";
      risks.push(
        `activity burst: ${(trend.burstConcentration * 100).toFixed(0)}% of swaps in first third of window (max ${(maxBurst * 100).toFixed(0)}%)`,
      );
    }

    const minSustained = policy.realtime.minSustainedRatio ?? 0.5;
    if (trend.sustainedRatio < minSustained) {
      reasonCode ??= "activity_not_sustained";
      risks.push(
        `only ${(trend.sustainedRatio * 100).toFixed(0)}% of time buckets have swaps (min ${(minSustained * 100).toFixed(0)}%)`,
      );
    }
  }

  if (risks.length === 0) {
    reasons.push(
      `realtime confirmed: ${realtime.swaps} swaps across ${realtime.distinctSlots} slots`,
    );
  }

  return {
    passed: risks.length === 0,
    ...(reasonCode ? { reasonCode } : {}),
    reasons,
    risks,
    realtime,
  };
}

export function buildEntrySnapshot(
  result: ScreeningResult,
  llmConfidence: number,
  now = Date.now(),
): EntrySnapshot {
  const activeTvl = Math.max(result.pool.activeTvl, 1);
  const entryPolicy =
    result.entryPolicy ??
    evaluateEntryPolicy(result.realtimeSignals, DEFAULT_ENTRY_POLICY, now);
  return {
    poolAddress: result.pool.address,
    poolName: result.pool.name,
    decisionTimestamp: now,
    activeBinId: result.pool.activeBinId,
    currentPrice: result.pool.currentPrice,
    binStep: result.pool.binStep,
    tvl: result.pool.tvl,
    activeTvl: result.pool.activeTvl,
    volumeWindow: result.pool.volume24h,
    feesWindow: result.pool.fees24h,
    feeActiveTvlRatioPct: (result.pool.fees24h / activeTvl) * 100,
    realtime: entryPolicy.realtime,
    realtimeEvents: compactEntryRealtimeEvents(
      result.realtimeSignals,
      result.pool.address,
      20,
    ),
    llmConfidence,
  };
}

export function compactEntryRealtimeEvents(
  events: RealtimeEvent[],
  poolAddress: string,
  limit = 20,
): EntryRealtimeEvent[] {
  return events
    .filter((event) => event.poolAddress === poolAddress)
    .slice(-Math.max(0, limit))
    .map((event) => ({
      kind: event.kind,
      poolAddress,
      ...(event.signature ? { signature: event.signature } : {}),
      ...(typeof event.slot === "number" && Number.isFinite(event.slot)
        ? { slot: event.slot }
        : {}),
      timestamp: event.timestamp,
      ...(typeof event.amountUsd === "number" &&
      Number.isFinite(event.amountUsd)
        ? { amountUsd: event.amountUsd }
        : {}),
    }));
}

export function validateFreshEntry(
  input: FreshEntryValidationInput,
): FreshEntryValidation {
  const now = input.now ?? Date.now();
  const policy = input.config.entryPolicy;
  const reasons: string[] = [];
  const risks: string[] = [];
  const metrics: Record<string, number | string | boolean | null> = {};
  let reasonCode: string | undefined;
  let sizeMultiplier = 1;

  if (!policy.enabled) {
    return {
      passed: true,
      reasons: ["entry policy disabled"],
      risks,
      metrics,
      sizeMultiplier,
    };
  }

  const snapshotAgeMs = Math.max(0, now - input.snapshot.decisionTimestamp);
  metrics.snapshotAgeMs = snapshotAgeMs;
  if (snapshotAgeMs > policy.freshness.maxSnapshotAgeMs) {
    reasonCode ??= "stale_snapshot";
    risks.push(
      `entry snapshot age ${snapshotAgeMs}ms exceeds ${policy.freshness.maxSnapshotAgeMs}ms`,
    );
  }

  const hardFilter = evaluateFreshHardFilters(
    input.freshPool,
    input.config.filters,
  );
  metrics.freshFiltersPassed = hardFilter.passed;
  if (!hardFilter.passed) {
    reasonCode ??= "fresh_filter_failed";
    risks.push(`fresh filter failed: ${hardFilter.failures.join(", ")}`);
  }

  const collapseGuard = evaluateCollapseGuard(input.freshPool, input.config);
  for (const [key, value] of Object.entries(collapseGuard.metrics)) {
    metrics[`collapseGuard.${key}`] = value;
  }
  if (!collapseGuard.passed) {
    metrics.collapseGuardPassed = false;
    if (policy.collapseGuard.mode === "enforce") {
      reasonCode ??= collapseGuard.reasonCode ?? "collapse_guard_failed";
      risks.push(...collapseGuard.risks);
    } else {
      reasons.push(...collapseGuard.risks.map((risk) => `observe: ${risk}`));
    }
  } else {
    metrics.collapseGuardPassed = true;
    if (collapseGuard.action === "reduce_size") {
      sizeMultiplier = Math.min(sizeMultiplier, collapseGuard.sizeMultiplier);
      metrics.collapseGuardSizeMultiplier = collapseGuard.sizeMultiplier;
      reasons.push(
        `collapse guard reduce_size (riskScore ${collapseGuard.riskScore}): open at ${(collapseGuard.sizeMultiplier * 100).toFixed(0)}% size`,
      );
    }
  }

  const realtime = evaluateEntryPolicy(input.freshEvents, policy, now);
  metrics.freshRealtimeSource = input.freshRealtimeSource ?? null;
  metrics.freshRealtimePassed = realtime.passed;
  metrics.freshRealtimeSwaps = realtime.realtime.swaps;
  metrics.freshRealtimeDistinctSlots = realtime.realtime.distinctSlots;
  metrics.freshRealtimeLatestAgeMs =
    realtime.realtime.latestSignalAgeMs ?? null;
  if (!realtime.passed) {
    reasonCode ??= realtime.reasonCode ?? "entry_policy_failed";
    risks.push(...realtime.risks);
  }

  const activeBinDrift = Math.abs(
    input.freshPool.activeBinId - input.snapshot.activeBinId,
  );
  metrics.activeBinDrift = activeBinDrift;
  if (activeBinDrift > policy.freshness.maxActiveBinDriftBins) {
    reasonCode ??= "active_bin_drift";
    risks.push(
      `active bin drift ${activeBinDrift} exceeds ${policy.freshness.maxActiveBinDriftBins}`,
    );
  }

  const priceMovePct = pctMove(
    input.snapshot.currentPrice,
    input.freshPool.currentPrice,
  );
  metrics.priceMovePct = priceMovePct ?? null;
  if (
    priceMovePct !== undefined &&
    priceMovePct > policy.freshness.maxPriceMovePct
  ) {
    reasonCode ??= "price_moved";
    risks.push(
      `price moved ${priceMovePct.toFixed(2)}% exceeds ${policy.freshness.maxPriceMovePct}%`,
    );
  }

  if (risks.length === 0) {
    reasons.push("fresh pre-open validation passed");
  }

  const passed = risks.length === 0;
  return {
    passed,
    ...(reasonCode ? { reasonCode } : {}),
    reasons,
    risks,
    metrics,
    sizeMultiplier: passed ? sizeMultiplier : 1,
  };
}

export function evaluateFreshHardFilters(
  pool: Pool,
  filters: HardFilters,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const activeTvl = Math.max(pool.activeTvl, 1);
  const feeRatioPct = (pool.fees24h / activeTvl) * 100;
  if (feeRatioPct < filters.feeActiveTvlRatioMin) {
    failures.push(
      `feeActiveTvlRatio ${feeRatioPct.toFixed(4)} < ${filters.feeActiveTvlRatioMin}`,
    );
  }
  if (pool.binStep < filters.binStepMin || pool.binStep > filters.binStepMax) {
    failures.push(
      `binStep ${pool.binStep} outside ${filters.binStepMin}..${filters.binStepMax}`,
    );
  }
  if (pool.tvl < filters.tvlMin || pool.tvl > filters.tvlMax) {
    failures.push(
      `tvl ${pool.tvl} outside ${filters.tvlMin}..${filters.tvlMax}`,
    );
  }
  if (
    typeof filters.volume24hMin === "number" &&
    pool.volume24h < filters.volume24hMin
  ) {
    failures.push(`volume ${pool.volume24h} < ${filters.volume24hMin}`);
  }

  const included = filters.includedTokens ?? [];
  const xIsQuote = included.length > 0 && included.includes(pool.tokenX.mint);
  const yIsQuote = included.length > 0 && included.includes(pool.tokenY.mint);
  if (included.length > 0 && xIsQuote === yIsQuote) {
    failures.push("includedTokens requires exactly one quote side");
  }

  const screened = [
    { token: pool.tokenX, isQuote: xIsQuote },
    { token: pool.tokenY, isQuote: yIsQuote },
  ].filter((item) => !item.isQuote);
  for (const { token } of screened) {
    if (
      typeof token.organicScore === "number" &&
      token.organicScore < filters.organicScoreMin
    ) {
      failures.push(
        `${token.symbol} organic ${token.organicScore} < ${filters.organicScoreMin}`,
      );
    }
    if (
      typeof token.holders === "number" &&
      token.holders < filters.holdersMin
    ) {
      failures.push(
        `${token.symbol} holders ${token.holders} < ${filters.holdersMin}`,
      );
    }
    if (
      typeof token.marketCap === "number" &&
      (token.marketCap < filters.marketCapMin ||
        token.marketCap > filters.marketCapMax)
    ) {
      failures.push(
        `${token.symbol} marketCap ${token.marketCap} outside ${filters.marketCapMin}..${filters.marketCapMax}`,
      );
    }
  }

  return { passed: failures.length === 0, failures };
}

/**
 * Graduated collapse guard. Hard vetoes (dev sold all, missing risk data when
 * required, no screened token) BLOCK outright. Everything else accumulates a
 * per-token risk score; the worst screened token decides the action:
 *   score >= blockRiskScore  -> block
 *   score >= reduceRiskScore -> reduce_size (open at reduceSizeMultiplier)
 *   else                     -> allow
 * This replaces the prior binary veto so that medium-risk memecoins can still
 * trade (at reduced size) and produce real PnL for the learning loop, instead
 * of every dev with a single prior rug being blocked.
 */
export function evaluateCollapseGuard(
  pool: Pool,
  config: UserConfig,
): CollapseGuardResult {
  const guard = config.entryPolicy.collapseGuard;
  const metrics: Record<string, number | string | boolean | null> = {};
  const reasons: string[] = [];
  const risks: string[] = [];

  if (!guard.enabled) {
    return {
      passed: true,
      action: "allow",
      riskScore: 0,
      sizeMultiplier: 1,
      reasons: ["collapse guard disabled"],
      risks,
      metrics,
    };
  }

  const blockScore = guard.blockRiskScore;
  const reduceScore = guard.reduceRiskScore;
  const reduceMultiplier = guard.reduceSizeMultiplier;

  const screened = screenedTokensForPool(pool, config.filters);
  metrics.screenedTokenCount = screened.length;
  if (screened.length === 0) {
    risks.push("collapse_guard_failed: no screened non-quote token");
    return blockResult(reasons, risks, metrics);
  }

  let maxScore = 0;

  for (const token of screened) {
    const risk = token.risk;
    const prefix = `${token.symbol}:`;
    const hasRiskData = hasCollapseRiskData(token);
    metrics[`${token.symbol}.riskData`] = hasRiskData;

    // Hard vetoes — these always block regardless of score.
    if (guard.requireRiskDataForEnter && !hasRiskData) {
      risks.push(`${prefix} missing OKX risk data`);
      return blockResult(reasons, risks, metrics);
    }
    if (guard.blockDevSoldAll && risk?.devSoldAll === true) {
      risks.push(`${prefix} dev_sold_all`);
      return blockResult(reasons, risks, metrics);
    }

    // Graduated factors.
    let score = 0;
    if (
      typeof risk?.devRugCount === "number" &&
      risk.devRugCount > guard.maxDevRugCount
    ) {
      const band = risk.devRugCount >= 3 ? 40 : risk.devRugCount >= 2 ? 20 : 10;
      score += band;
      risks.push(
        `${prefix} serial_deployer devRugCount ${risk.devRugCount} (+${band})`,
      );
    }
    if (
      typeof risk?.priceVsAthPct === "number" &&
      risk.priceVsAthPct < guard.priceVsAthPctMin
    ) {
      const severe = risk.priceVsAthPct < guard.priceVsAthPctMin - 15;
      const band = severe ? 30 : 15;
      score += band;
      risks.push(
        `${prefix} ath_drawdown priceVsAthPct ${risk.priceVsAthPct.toFixed(2)} < ${guard.priceVsAthPctMin} (+${band})`,
      );
    }
    if (
      typeof risk?.sniperPct === "number" &&
      risk.sniperPct > guard.maxSniperPct
    ) {
      score += 15;
      risks.push(
        `${prefix} sniper_concentration ${risk.sniperPct.toFixed(2)} > ${guard.maxSniperPct} (+15)`,
      );
    }
    if (
      typeof risk?.devTokenCount === "number" &&
      risk.devTokenCount > guard.maxDevTokenCount
    ) {
      score += 15;
      risks.push(
        `${prefix} serial_deployer devTokenCount ${risk.devTokenCount} > ${guard.maxDevTokenCount} (+15)`,
      );
    }

    maxScore = Math.max(maxScore, score);
    metrics[`${token.symbol}.riskScore`] = score;
    metrics[`${token.symbol}.priceVsAthPct`] = risk?.priceVsAthPct ?? null;
    metrics[`${token.symbol}.devRugCount`] = risk?.devRugCount ?? null;
    metrics[`${token.symbol}.devTokenCount`] = risk?.devTokenCount ?? null;
    metrics[`${token.symbol}.sniperPct`] = risk?.sniperPct ?? null;
    metrics[`${token.symbol}.devSoldAll`] = risk?.devSoldAll ?? null;
  }

  metrics.riskScore = maxScore;

  if (maxScore >= blockScore) {
    return blockResult(reasons, risks, metrics, maxScore);
  }
  if (maxScore >= reduceScore) {
    metrics.collapseGuardAction = "reduce_size";
    metrics.sizeMultiplier = reduceMultiplier;
    return {
      passed: true,
      action: "reduce_size",
      riskScore: maxScore,
      sizeMultiplier: reduceMultiplier,
      reasons: [`collapse guard reduce_size (riskScore ${maxScore})`],
      risks,
      metrics,
    };
  }

  metrics.collapseGuardAction = "allow";
  metrics.sizeMultiplier = 1;
  reasons.push("collapse guard passed");
  return {
    passed: true,
    action: "allow",
    riskScore: maxScore,
    sizeMultiplier: 1,
    reasons,
    risks,
    metrics,
  };
}

function blockResult(
  reasons: string[],
  risks: string[],
  metrics: Record<string, number | string | boolean | null>,
  riskScore = 0,
): CollapseGuardResult {
  metrics.collapseGuardAction = "block";
  metrics.sizeMultiplier = 0;
  metrics.riskScore = riskScore;
  return {
    passed: false,
    action: "block",
    riskScore,
    sizeMultiplier: 0,
    reasonCode: "collapse_guard_failed",
    reasons,
    risks,
    metrics,
  };
}

export function selectTopEnterCandidates<T extends DeployCandidateLike>(
  candidates: T[],
  maxDeploys: number,
  weights?: ScoringWeights,
): T[] {
  const limit = Math.max(0, Math.floor(maxDeploys));
  if (limit === 0) return [];
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: scoreEnterCandidate(candidate, weights),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.candidate);
}

export interface ScoringWeights {
  confidence?: number;
  feeRatio?: number;
  volumeRatio?: number;
  swaps?: number;
  liquidityAdds?: number;
  volumeSpikes?: number;
  liquidityRemoves?: number;
  riskCount?: number;
}

const DEFAULT_SCORING_WEIGHTS: Required<ScoringWeights> = {
  confidence: 10_000,
  feeRatio: 100,
  volumeRatio: 20,
  swaps: 5,
  liquidityAdds: 3,
  volumeSpikes: 2,
  liquidityRemoves: 8,
  riskCount: 2,
};

export function scoreEnterCandidate(candidate: DeployCandidateLike, weights?: ScoringWeights): number {
  const w = { ...DEFAULT_SCORING_WEIGHTS, ...weights };
  const activeTvl = Math.max(candidate.pool.activeTvl, 1);
  const tvl = Math.max(candidate.pool.tvl, 1);
  const feeRatioPct = (candidate.pool.fees24h / activeTvl) * 100;
  const volumeRatioPct = (candidate.pool.volume24h / tvl) * 100;
  const realtime =
    candidate.entryPolicy?.realtime ??
    summarizeRealtimeSignals(candidate.realtimeSignals);
  const confidence = candidate.decision?.confidence ?? 0;
  const riskCount = candidate.decision?.risks?.length ?? 0;

  return (
    confidence * w.confidence +
    feeRatioPct * w.feeRatio +
    volumeRatioPct * w.volumeRatio +
    realtime.swaps * w.swaps +
    realtime.liquidityAdds * w.liquidityAdds +
    realtime.volumeSpikes * w.volumeSpikes -
    realtime.liquidityRemoves * w.liquidityRemoves -
    riskCount * w.riskCount
  );
}

export function recentForFromSnapshotFile(
  filePath: string,
  poolAddress: string,
  limit = 20,
): RealtimeEvent[] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { events?: unknown };
    if (!Array.isArray(parsed.events)) return [];
    return parsed.events
      .filter(isRealtimeEvent)
      .filter((event) => event.poolAddress === poolAddress)
      .slice(-Math.max(0, limit));
  } catch {
    return [];
  }
}

function screenedTokensForPool(
  pool: Pool,
  filters?: HardFilters,
): Array<Pool["tokenX"]> {
  const included = filters?.includedTokens ?? [];
  const xIsQuote = included.length > 0 && included.includes(pool.tokenX.mint);
  const yIsQuote = included.length > 0 && included.includes(pool.tokenY.mint);
  const screened = [
    { token: pool.tokenX, isQuote: xIsQuote },
    { token: pool.tokenY, isQuote: yIsQuote },
  ].filter((item) => !item.isQuote);
  return screened.length > 0
    ? screened.map((item) => item.token)
    : [pool.tokenX, pool.tokenY];
}

function hasCollapseRiskData(token: Pool["tokenX"]): boolean {
  const risk = token.risk;
  if (!risk) return false;
  return (
    risk.available === true ||
    typeof risk.riskScore === "number" ||
    typeof risk.devSoldAll === "boolean" ||
    typeof risk.priceVsAthPct === "number" ||
    typeof risk.devRugCount === "number" ||
    typeof risk.devTokenCount === "number" ||
    typeof risk.sniperPct === "number"
  );
}

function pctMove(from: number, to: number): number | undefined {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
    return undefined;
  }
  return (Math.abs(to - from) / Math.abs(from)) * 100;
}

function isRealtimeEvent(input: unknown): input is RealtimeEvent {
  if (!input || typeof input !== "object") return false;
  const obj = input as Record<string, unknown>;
  return typeof obj.kind === "string" && typeof obj.timestamp === "number";
}
