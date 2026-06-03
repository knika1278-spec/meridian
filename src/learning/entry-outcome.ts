// Entry outcome computer (market proxy side, T07).
// Fetches fresh pool state at a horizon and computes proxy deltas vs.
// the captured decision features. Realized PnL is handled in T08.
// Pure module: no scheduling, no JSONL writes. Never throws.

import type {
  LearningDecision,
  LearningOutcome,
  Pool,
} from "../types/index.js";
import type { MeteoraTools } from "../tools/meteora.tools.js";
import type { JupiterTools } from "../tools/jupiter.tools.js";
import { scoreNetPnlRisk, SCORE_VERSION } from "./score-net-pnl-risk.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("entry-outcome");

export interface EntryOutcomeComputerOptions {
  meteora: MeteoraTools;
  jupiter?: JupiterTools;
}

function deltaPct(current: number, previous: number): number | undefined {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return undefined;
  if (previous === 0) return undefined;
  return (current - previous) / previous;
}

export class EntryOutcomeComputer {
  private readonly meteora: MeteoraTools;
  // jupiter is reserved for future price enrichment; currently unused.
  private readonly jupiter: JupiterTools | undefined;

  constructor(opts: EntryOutcomeComputerOptions) {
    this.meteora = opts.meteora;
    this.jupiter = opts.jupiter;
  }

  /**
   * Always returns a LearningOutcome (never throws). On error, returns one
   * with `riskFlagsTripped` populated and a neutral score.
   */
  async compute(
    decision: LearningDecision,
    horizonMinutes: number,
  ): Promise<LearningOutcome> {
    const evaluatedAt = Date.now();

    // Touch jupiter reference (kept for forward-compatibility).
    void this.jupiter;

    let pool: Pool | null = null;
    try {
      // MeteoraTools exposes `fetchPairByAddress` (see src/tools/meteora.tools.ts).
      pool = await this.meteora.fetchPairByAddress(decision.pool.address);
    } catch (err) {
      log.warn(
        {
          poolAddress: decision.pool.address,
          decisionId: decision.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "fetchPairByAddress failed",
      );
      const riskFlagsTripped = ["fetch_failed"];
      return {
        decisionId: decision.id,
        horizonMinutes,
        kind: "entry_market_proxy",
        evaluatedAt,
        riskFlagsTripped,
        netPnlRiskScore: 0,
        scoreVersion: SCORE_VERSION,
      };
    }

    if (!pool) {
      const riskFlagsTripped = ["pool_unavailable"];
      const netPnlRiskScore = scoreNetPnlRisk({ riskFlagsTripped });
      return {
        decisionId: decision.id,
        horizonMinutes,
        kind: "entry_market_proxy",
        evaluatedAt,
        riskFlagsTripped,
        netPnlRiskScore,
        scoreVersion: SCORE_VERSION,
      };
    }

    // AUDIT FIX [PHASE-1.5]: reconcile the horizon price/bin basis with the entry
    // snapshot. entryPrice (recorder.ts) is captured from the screener pool, whose
    // currentPrice is overridden with the on-chain active-bin price when enrichment
    // succeeds. fetchPairByAddress alone returns the detail-API `current_price` (a
    // DIFFERENT basis) and leaves activeBinId = 0. Without enrichment here,
    // priceReturn collapsed to ~-1 for ~88% of pools and activeBinDrift was just the
    // entry bin id (so active_bin_drifted_out tripped on every pool). Enrich so both
    // sides share the on-chain active-bin basis.
    let onchainPriceBasis = false;
    let onchainBinBasis = false;
    try {
      const enriched = await this.meteora.enrichOnChain(decision.pool.address);
      if (
        typeof enriched.activeBinId === "number" &&
        Number.isFinite(enriched.activeBinId)
      ) {
        pool.activeBinId = enriched.activeBinId;
        onchainBinBasis = true;
      }
      if (
        typeof enriched.currentPrice === "number" &&
        Number.isFinite(enriched.currentPrice) &&
        enriched.currentPrice > 0
      ) {
        pool.currentPrice = enriched.currentPrice;
        onchainPriceBasis = true;
      }
    } catch {
      // enrichOnChain is best-effort and never throws; fall back to REST basis.
    }

    const features = decision.features;

    // feeActiveTvlChange
    let feeActiveTvlChange: number | undefined;
    const currentFeeActiveTvl = pool.fees24h / Math.max(pool.activeTvl, 1);
    if (
      features.feeOverActiveTvl !== undefined &&
      Number.isFinite(features.feeOverActiveTvl) &&
      features.feeOverActiveTvl !== 0
    ) {
      feeActiveTvlChange = deltaPct(
        currentFeeActiveTvl,
        features.feeOverActiveTvl,
      );
    }

    // volumeTvlChange
    let volumeTvlChange: number | undefined;
    const currentVolumeTvl = pool.volume24h / Math.max(pool.tvl, 1);
    if (
      features.volumeOverTvl !== undefined &&
      Number.isFinite(features.volumeOverTvl) &&
      features.volumeOverTvl !== 0
    ) {
      volumeTvlChange = deltaPct(currentVolumeTvl, features.volumeOverTvl);
    }

    // activeBinDrift
    // AUDIT FIX [PHASE-1.5]: only meaningful when the horizon activeBinId came from
    // on-chain enrichment. Without it pool.activeBinId is 0 and the "drift" would
    // just be the entry bin id — a false positive on every pool.
    let activeBinDrift: number | undefined;
    if (
      onchainBinBasis &&
      features.activeBinId !== undefined &&
      Number.isFinite(features.activeBinId) &&
      Number.isFinite(pool.activeBinId)
    ) {
      activeBinDrift = Math.abs(pool.activeBinId - features.activeBinId);
    }

    // AUDIT FIX [PHASE-1.5]: only trust priceReturn when the horizon price shares
    // the entry's on-chain basis. Otherwise a cross-API unit mismatch makes it
    // meaningless — drop it (and flag) rather than feed the scorer a fabricated ~-1.
    const priceReturn = onchainPriceBasis
      ? deltaPctFromEntry(pool.currentPrice, features.entryPrice)
      : undefined;

    // Risk flags
    const riskFlagsTripped: string[] = [];
    if (pool.activeTvl <= 0) riskFlagsTripped.push("tvl_collapsed");
    if (pool.fees24h <= 0) riskFlagsTripped.push("fee_zero");
    // AUDIT FIX [PHASE-1.5]: a low-information outcome (no comparable on-chain
    // price). The flag's penalty offsets any fee-growth credit so unmeasurable
    // outcomes settle near-neutral instead of leaking a false-positive score.
    if (!onchainPriceBasis) riskFlagsTripped.push("price_basis_unmeasurable");
    const driftLimit = activeBinDriftLimitFor(features);
    if (
      activeBinDrift !== undefined &&
      driftLimit !== undefined &&
      activeBinDrift > driftLimit
    ) {
      riskFlagsTripped.push("active_bin_drifted_out");
    }

    const netPnlRiskScore = scoreNetPnlRisk({
      priceReturn,
      feeActiveTvlChange,
      riskFlagsTripped,
    });

    const outcome: LearningOutcome = {
      decisionId: decision.id,
      horizonMinutes,
      kind: "entry_market_proxy",
      evaluatedAt,
      riskFlagsTripped,
      netPnlRiskScore,
      scoreVersion: SCORE_VERSION,
    };
    if (priceReturn !== undefined) outcome.priceReturn = priceReturn;
    if (feeActiveTvlChange !== undefined) {
      outcome.feeActiveTvlChange = feeActiveTvlChange;
    }
    if (volumeTvlChange !== undefined)
      outcome.volumeTvlChange = volumeTvlChange;
    if (activeBinDrift !== undefined) outcome.activeBinDrift = activeBinDrift;

    return outcome;
  }
}

function deltaPctFromEntry(
  currentPrice: number | undefined,
  entryPrice: number | undefined,
): number | undefined {
  if (entryPrice === undefined || currentPrice === undefined) return undefined;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice)) {
    return undefined;
  }
  if (entryPrice <= 0 || currentPrice <= 0) return undefined;
  return deltaPct(currentPrice, entryPrice);
}

function activeBinDriftLimitFor(
  features: LearningDecision["features"],
): number | undefined {
  const rangeBinsPerSide = features.rangeBinsPerSide;
  if (
    rangeBinsPerSide !== undefined &&
    Number.isFinite(rangeBinsPerSide) &&
    rangeBinsPerSide > 0
  ) {
    return Math.max(2, Math.ceil(rangeBinsPerSide));
  }

  const binStep = features.binStep;
  if (binStep === undefined || !Number.isFinite(binStep) || binStep <= 0) {
    return 50;
  }
  if (binStep >= 80) return 8;
  if (binStep >= 50) return 12;
  if (binStep >= 20) return 25;
  return 50;
}
