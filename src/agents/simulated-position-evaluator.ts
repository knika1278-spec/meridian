/**
 * SimulatedPositionEvaluator
 *
 * Evaluates dry-run positions that were never submitted on-chain by deriving
 * current value from live pool data + an IL approximation.  Mirrors the
 * 70%-alignment approach from Meridian: same pool data → same decision inputs.
 *
 * IL model: constant-product approximation
 *   k = currentPrice / entryPrice
 *   ilFraction = 2 * sqrt(k) / (1 + k) - 1   (≤ 0)
 *
 * Fee estimation: pool.fees24h / 1440 * minutesHeld / estimatedProviders
 */

import type { JupiterTools } from "../tools/jupiter.tools.js";
import type { MeteoraTools } from "../tools/meteora.tools.js";
import type {
  ClaimableFees,
  ManagerConfig,
  Position,
  PositionEvaluation,
  SimulatedPositionState,
} from "../types/index.js";
import { normalizeIlLossUsd } from "../utils/pnl.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("simulated-position-evaluator");

const DEFAULT_ESTIMATED_PROVIDERS = 50;

/**
 * Maximum plausible price ratio (current/entry, either direction) before we
 * treat the reading as a data/unit glitch rather than a real move. The screener
 * list and the per-pool detail API can report price in different scales, which
 * has produced ~1000x phantom drops (k≈0.001 → IL model returns ~-94%, firing a
 * false stop-loss in seconds). A 100x guard catches those while still allowing
 * genuine deep memecoin moves (down to ~-99%).
 */
const SUSPICIOUS_PRICE_RATIO = 100;

export class SimulatedPositionEvaluator {
  private readonly estimatedProviders: number;

  constructor(
    private readonly meteora: MeteoraTools,
    private readonly jupiter: JupiterTools,
    cfg: Pick<ManagerConfig, "estimatedProviders">,
  ) {
    this.estimatedProviders =
      cfg.estimatedProviders ?? DEFAULT_ESTIMATED_PROVIDERS;
  }

  async evaluate(position: Position): Promise<PositionEvaluation | null> {
    const now = Date.now();

    const pool = await this.meteora.fetchPairByAddress(position.poolAddress);
    if (!pool) return null;

    const currentActiveBinId = pool.activeBinId;
    const currentPrice = pool.currentPrice;

    const inRange =
      currentActiveBinId >= position.lowerBinId &&
      currentActiveBinId <= position.upperBinId;

    let priceX = pool.tokenX.priceUsd;
    let priceY = pool.tokenY.priceUsd;

    if (!priceX || !priceY) {
      const mints = [
        ...(priceX === undefined ? [position.tokenX.mint] : []),
        ...(priceY === undefined ? [position.tokenY.mint] : []),
      ];
      if (mints.length > 0) {
        const stats = await this.jupiter.getPriceStats(mints);
        if (!priceX) priceX = stats[position.tokenX.mint]?.priceUsd;
        if (!priceY) priceY = stats[position.tokenY.mint]?.priceUsd;
      }
    }

    if (!priceX || !priceY) return null;

    const decX = position.tokenX.decimals;
    const decY = position.tokenY.decimals;
    const entryUiX = Number(BigInt(position.entryAmountX)) / 10 ** decX;
    const entryUiY = Number(BigInt(position.entryAmountY)) / 10 ** decY;

    const hodlValueUsd = entryUiX * priceX + entryUiY * priceY;
    const ilUsd = this.estimateIlLossUsd(
      hodlValueUsd,
      position.entryPrice,
      currentPrice,
    );
    const currentValueUsd = Math.max(0, hodlValueUsd - ilUsd);

    const { amtX, amtY } = this.computeCurrentAmounts(
      position,
      currentActiveBinId,
      currentValueUsd,
      entryUiX,
      entryUiY,
      priceX,
      priceY,
    );

    const ageMinutes = (now - position.entryTimestamp) / 60_000;
    const newFeesUsd = this.estimateFees(pool.fees24h, ageMinutes);

    const prevSim: SimulatedPositionState | undefined = position.sim;
    const accruedFeesUsd = Math.max(prevSim?.accruedFeesUsd ?? 0, newFeesUsd);

    const pnlUsd = currentValueUsd + accruedFeesUsd - position.entryValueUsd;
    const pnlPct =
      position.entryValueUsd > 0 ? pnlUsd / position.entryValueUsd : 0;

    const claimableFees = this.buildClaimableFees(
      accruedFeesUsd,
      entryUiX,
      entryUiY,
      priceX,
      priceY,
      decX,
      decY,
    );

    const prevInRangePct =
      prevSim !== undefined ? (prevSim.inRange ? 1 : 0) : 1;
    const alpha = 0.1;
    const inRangePct = (1 - alpha) * prevInRangePct + alpha * (inRange ? 1 : 0);

    const firstOutOfRangeAt = inRange
      ? undefined
      : (prevSim?.firstOutOfRangeAt ??
        (prevSim && !prevSim.inRange ? prevSim.lastUpdated : now));
    const outOfRangeMinutes = firstOutOfRangeAt
      ? Math.max(0, (now - firstOutOfRangeAt) / 60_000)
      : 0;

    const simState: SimulatedPositionState = {
      currentValueUsd,
      accruedFeesUsd,
      activeBinId: currentActiveBinId,
      inRange,
      ...(firstOutOfRangeAt ? { firstOutOfRangeAt } : {}),
      lastUpdated: now,
    };

    (position as Position).sim = simState;

    return {
      position,
      evaluatedAt: now,
      currentActiveBinId,
      inRange,
      inRangePct,
      outOfRangeMinutes,
      currentPrice,
      currentAmountX: BigInt(Math.round(amtX * 10 ** decX)).toString(),
      currentAmountY: BigInt(Math.round(amtY * 10 ** decY)).toString(),
      currentValueUsd,
      claimableFees,
      pnlUsd,
      pnlPct,
      ilUsd,
      ageMinutes,
    };
  }

  private computeCurrentAmounts(
    position: Position,
    activeBinId: number,
    currentValueUsd: number,
    entryUiX: number,
    entryUiY: number,
    priceX: number,
    priceY: number,
  ): { amtX: number; amtY: number } {
    if (activeBinId < position.lowerBinId) {
      // Below range: all tokenX (base token)
      return {
        amtX: priceX > 0 ? currentValueUsd / priceX : entryUiX,
        amtY: 0,
      };
    }

    if (activeBinId > position.upperBinId) {
      // Above range: all tokenY (quote token)
      return {
        amtX: 0,
        amtY: priceY > 0 ? currentValueUsd / priceY : entryUiY,
      };
    }

    const entryXUsd = entryUiX * priceX;
    const entryYUsd = entryUiY * priceY;
    const totalEntryUsd = entryXUsd + entryYUsd;
    const xRatio = totalEntryUsd > 0 ? entryXUsd / totalEntryUsd : 0.5;
    const yRatio = 1 - xRatio;

    return {
      amtX: priceX > 0 ? (currentValueUsd * xRatio) / priceX : entryUiX,
      amtY: priceY > 0 ? (currentValueUsd * yRatio) / priceY : entryUiY,
    };
  }

  private estimateIlLossUsd(
    hodlValueUsd: number,
    entryPrice: number,
    currentPrice: number,
  ): number {
    if (hodlValueUsd <= 0 || entryPrice <= 0) return 0;
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return hodlValueUsd;
    }
    const k = currentPrice / entryPrice;
    if (!Number.isFinite(k) || k <= 0) return hodlValueUsd;
    // Guard against price-scale glitches (e.g. ~1000x mismatch between the
    // screener-list and detail APIs). Such readings would otherwise drive the
    // IL model to ~-100% and trip a false stop-loss. Treat as no reliable IL.
    if (k > SUSPICIOUS_PRICE_RATIO || k < 1 / SUSPICIOUS_PRICE_RATIO) {
      log.warn(
        { entryPrice, currentPrice, ratio: k },
        "suspicious price ratio: skipping IL estimate (likely data/unit glitch)",
      );
      return 0;
    }
    const lpRelativeValue = (2 * Math.sqrt(k)) / (1 + k);
    return normalizeIlLossUsd(hodlValueUsd * (1 - lpRelativeValue));
  }

  private estimateFees(fees24h: number, minutesHeld: number): number {
    if (fees24h <= 0 || minutesHeld <= 0) return 0;
    return ((fees24h / 1440) * minutesHeld) / this.estimatedProviders;
  }

  private buildClaimableFees(
    accruedFeesUsd: number,
    entryUiX: number,
    entryUiY: number,
    priceX: number,
    priceY: number,
    decX: number,
    decY: number,
  ): ClaimableFees {
    const entryXusd = entryUiX * priceX;
    const entryYusd = entryUiY * priceY;
    const totalEntry = entryXusd + entryYusd;

    const ratioX = totalEntry > 0 ? entryXusd / totalEntry : 0.5;
    const feesXusd = accruedFeesUsd * ratioX;
    const feesYusd = accruedFeesUsd * (1 - ratioX);

    const rawFeesX = BigInt(Math.round((feesXusd / priceX) * 10 ** decX));
    const rawFeesY = BigInt(Math.round((feesYusd / priceY) * 10 ** decY));

    return {
      tokenX: rawFeesX.toString(),
      tokenY: rawFeesY.toString(),
      usdValue: accruedFeesUsd,
    };
  }
}
