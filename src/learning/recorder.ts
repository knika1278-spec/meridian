// Shared LearningRecorder — extracts decision features from screener
// ScreeningResult and manager PositionEvaluation/ManagerAction snapshots,
// then appends a LearningDecision row to the JSONL store. Best-effort: any
// failure is logged at warn-level and swallowed so the caller's hot path
// (screener cycle, manager tick) never aborts on learning I/O.

import type {
  UserConfig,
  LearningDecision,
  LearningDecisionFeatures,
  ScreeningResult,
  Position,
  PositionEvaluation,
  ManagerAction,
  PairClass,
  LearningActionAny,
  TokenInfo,
} from "../types/index.js";
import { JsonlStore } from "./jsonl-store.js";
import {
  makeScreenerDecisionId,
  makeManagerDecisionId,
} from "./decision-id.js";
import { childLogger, type Logger } from "../utils/logger.js";

const STABLES: ReadonlySet<string> = new Set(["USDC", "USDT", "USDH", "DAI"]);
const MAJORS: ReadonlySet<string> = new Set([
  "SOL",
  "WSOL",
  "BTC",
  "ETH",
  "JLP",
  "MSOL",
]);

const DEFAULT_MAX_RISK_FLAGS = 10;
const LLM_RAW_TRIM = 500;

export interface LearningRecorderOptions {
  decisionsStore: JsonlStore<LearningDecision & Record<string, unknown>>;
  learningConfig: UserConfig["learning"];
}

export class LearningRecorder {
  private readonly store: JsonlStore<
    LearningDecision & Record<string, unknown>
  >;
  private readonly cfg: UserConfig["learning"];
  private readonly log: Logger;

  constructor(opts: LearningRecorderOptions) {
    this.store = opts.decisionsStore;
    this.cfg = opts.learningConfig;
    this.log = childLogger("learning-recorder");
  }

  recordScreener(
    result: ScreeningResult,
    cycleId: string,
  ): LearningDecision | null {
    if (!this.cfg.enabled) return null;

    const action: LearningActionAny = result.decision?.action ?? "WATCH";
    const features = this.extractScreenerFeatures(result);

    const decision: LearningDecision = {
      id: makeScreenerDecisionId({
        cycleId,
        poolAddress: result.pool.address,
        action: action as "ENTER" | "WATCH" | "SKIP",
      }),
      kind: "screener",
      timestamp: result.timestamp,
      cycleId,
      pool: { address: result.pool.address, name: result.pool.name },
      action,
      ...(result.decision?.confidence !== undefined
        ? { confidence: result.decision.confidence }
        : {}),
      reasons: result.decision?.reasons ?? [],
      risks: result.decision?.risks ?? [],
      features,
      ...(result.deployGate ? { deployGate: result.deployGate } : {}),
      ...(result.decision?.suggestedSizeUsd !== undefined
        ? { suggestedSizeUsd: result.decision.suggestedSizeUsd }
        : {}),
      ...(result.decision?.suggestedRangeBps !== undefined
        ? { suggestedRangeBps: result.decision.suggestedRangeBps }
        : {}),
      ...(result.llmRaw
        ? { llmRaw: result.llmRaw.slice(0, LLM_RAW_TRIM) }
        : {}),
    };

    return this.safeAppend(decision);
  }

  recordManager(args: {
    position: Position;
    evaluation: PositionEvaluation;
    action: ManagerAction;
    cycleTimestamp: number;
  }): LearningDecision | null {
    if (!this.cfg.enabled) return null;

    const { position, evaluation, action, cycleTimestamp } = args;
    const kind = action.kind;
    if (kind === "error" || kind === "skip") return null;

    const upper = kind.toUpperCase() as
      | "HOLD"
      | "CLAIM"
      | "CLOSE"
      | "REBALANCE";

    const features = this.extractManagerFeatures(position, evaluation);

    const evaluationSnapshot: Record<string, unknown> = {
      currentActiveBinId: evaluation.currentActiveBinId,
      inRange: evaluation.inRange,
      inRangePct: evaluation.inRangePct,
      outOfRangeMinutes: evaluation.outOfRangeMinutes,
      currentValueUsd: evaluation.currentValueUsd,
      claimableFees: { usdValue: evaluation.claimableFees.usdValue },
      pnlUsd: evaluation.pnlUsd,
      pnlPct: evaluation.pnlPct,
      ilUsd: evaluation.ilUsd,
      ageMinutes: evaluation.ageMinutes,
    };

    const decision: LearningDecision = {
      id: makeManagerDecisionId({
        positionPubkey: position.positionPubkey,
        cycleTimestamp,
        action: upper,
      }),
      kind: "manager",
      timestamp: cycleTimestamp,
      pool: { address: position.poolAddress, name: position.poolName },
      positionPubkey: position.positionPubkey,
      action: upper,
      ...(action.confidence !== undefined
        ? { confidence: action.confidence }
        : {}),
      reasons: action.reason ? [action.reason] : [],
      risks: features.riskFlags ?? [],
      features,
      evaluationSnapshot,
      ...(action.newRangeBps !== undefined
        ? { suggestedRangeBps: action.newRangeBps }
        : {}),
      ...(action.raw ? { llmRaw: action.raw.slice(0, LLM_RAW_TRIM) } : {}),
    };

    return this.safeAppend(decision);
  }

  // ---------- internals ----------

  private safeAppend(decision: LearningDecision): LearningDecision | null {
    try {
      this.store.append(decision as LearningDecision & Record<string, unknown>);
      return decision;
    } catch (err) {
      this.log.warn(
        { err, id: decision.id, kind: decision.kind },
        "learning recorder append failed",
      );
      return null;
    }
  }

  private extractScreenerFeatures(
    result: ScreeningResult,
  ): LearningDecisionFeatures {
    const pool = result.pool;
    const activeTvl = Math.max(pool.activeTvl, 1);
    const tvl = Math.max(pool.tvl, 1);
    const feeOverActiveTvl = safeRatio(pool.fees24h, activeTvl);
    const volumeOverTvl = safeRatio(pool.volume24h, tvl);

    const featureToken = selectSpeculativeToken(pool.tokenX, pool.tokenY);
    const organicScore = featureToken.organicScore;
    const holders = featureToken.holders;
    const mcUsd = featureToken.marketCap;
    const entryPrice = finitePositive(pool.currentPrice);
    const rangeBinsPerSide = rangeBinsPerSideFromBps(
      result.decision?.suggestedRangeBps,
      pool.binStep,
    );

    const pairClass = classifyPair(pool.tokenX.symbol, pool.tokenY.symbol);

    const riskFlags = Object.entries(result.filterReport)
      .filter(([, v]) => v.passed === false)
      .map(([k]) => k)
      .slice(0, this.cfg.maxRiskFlags ?? DEFAULT_MAX_RISK_FLAGS);

    const features: LearningDecisionFeatures = {
      binStep: pool.binStep,
      tvlUsd: pool.tvl,
      activeBinId: pool.activeBinId,
      pairClass,
      riskFlags,
    };
    if (feeOverActiveTvl !== undefined)
      features.feeOverActiveTvl = feeOverActiveTvl;
    if (volumeOverTvl !== undefined) features.volumeOverTvl = volumeOverTvl;
    if (organicScore !== undefined) features.organicScore = organicScore;
    if (holders !== undefined) features.holders = holders;
    if (mcUsd !== undefined) features.mcUsd = mcUsd;
    if (entryPrice !== undefined) features.entryPrice = entryPrice;
    if (rangeBinsPerSide !== undefined)
      features.rangeBinsPerSide = rangeBinsPerSide;
    return features;
  }

  private extractManagerFeatures(
    position: Position,
    evaluation: PositionEvaluation,
  ): LearningDecisionFeatures {
    const pairClass = classifyPair(
      position.tokenX.symbol,
      position.tokenY.symbol,
    );

    const riskFlags: string[] = [];
    if (evaluation.ilUsd > 0) riskFlags.push("il_positive");
    if (evaluation.outOfRangeMinutes > 30) riskFlags.push("out_of_range_long");
    if (evaluation.inRangePct < 0.4) riskFlags.push("in_range_low");

    const features: LearningDecisionFeatures = {
      binStep: position.binStep,
      lowerBinId: position.lowerBinId,
      upperBinId: position.upperBinId,
      activeBinId: evaluation.currentActiveBinId,
      inRangePct: evaluation.inRangePct,
      outOfRangeMinutes: evaluation.outOfRangeMinutes,
      pnlUsd: evaluation.pnlUsd,
      ilUsd: evaluation.ilUsd,
      ageMinutes: evaluation.ageMinutes,
      claimableFeesUsd: evaluation.claimableFees.usdValue,
      pairClass,
      riskFlags,
    };
    const entryPrice = finitePositive(position.entryPrice);
    if (entryPrice !== undefined) features.entryPrice = entryPrice;
    const rangeBinsPerSide = rangeBinsPerSideFromBounds(
      position.lowerBinId,
      position.upperBinId,
    );
    if (rangeBinsPerSide !== undefined)
      features.rangeBinsPerSide = rangeBinsPerSide;
    return features;
  }
}

// ---------- helpers ----------

function safeRatio(numerator: number, denominator: number): number | undefined {
  if (denominator <= 0) return undefined;
  const r = numerator / denominator;
  if (!Number.isFinite(r) || Number.isNaN(r)) return undefined;
  return r;
}

function finitePositive(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function rangeBinsPerSideFromBps(
  rangeBps: number | undefined,
  binStep: number | undefined,
): number | undefined {
  if (rangeBps === undefined || binStep === undefined) return undefined;
  if (!Number.isFinite(rangeBps) || !Number.isFinite(binStep)) {
    return undefined;
  }
  if (rangeBps <= 0 || binStep <= 0) return undefined;
  return rangeBps / (2 * binStep);
}

function rangeBinsPerSideFromBounds(
  lowerBinId: number | undefined,
  upperBinId: number | undefined,
): number | undefined {
  if (lowerBinId === undefined || upperBinId === undefined) return undefined;
  if (!Number.isFinite(lowerBinId) || !Number.isFinite(upperBinId)) {
    return undefined;
  }
  const width = Math.abs(upperBinId - lowerBinId);
  if (width <= 0) return undefined;
  return width / 2;
}

function classifyPair(
  symbolX: string | undefined,
  symbolY: string | undefined,
): PairClass {
  if (!symbolX || !symbolY) return "unknown";
  const xStable = isStableSymbol(symbolX);
  const yStable = isStableSymbol(symbolY);
  const xMajor = isMajorSymbol(symbolX);
  const yMajor = isMajorSymbol(symbolY);
  if (xStable && yStable) return "stable";
  if ((xMajor && yStable) || (yMajor && xStable)) return "major";
  if (xMajor && yMajor) return "major";
  return "exotic";
}

function selectSpeculativeToken(
  tokenX: TokenInfo,
  tokenY: TokenInfo,
): TokenInfo {
  const xQuoteLike = isQuoteLikeSymbol(tokenX.symbol);
  const yQuoteLike = isQuoteLikeSymbol(tokenY.symbol);

  if (xQuoteLike && !yQuoteLike) return tokenY;
  return tokenX;
}

function isQuoteLikeSymbol(symbol: string | undefined): boolean {
  return isStableSymbol(symbol) || isMajorSymbol(symbol);
}

function isStableSymbol(symbol: string | undefined): boolean {
  return symbol !== undefined && STABLES.has(normalizeSymbol(symbol));
}

function isMajorSymbol(symbol: string | undefined): boolean {
  return symbol !== undefined && MAJORS.has(normalizeSymbol(symbol));
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}
