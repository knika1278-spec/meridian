import type {
  ClaimableFees,
  ManagerConfig,
  Position,
  PositionEvaluation,
  RemoteMeteoraPnl,
} from "../types/index.js";
import type { MeteoraActions } from "../tools/meteora-actions.tools.js";
import type { MeteoraTools } from "../tools/meteora.tools.js";
import type { JupiterTools } from "../tools/jupiter.tools.js";
import type { MeteoraPnlTools } from "../tools/meteora-pnl.tools.js";
import { SimulatedPositionEvaluator } from "./simulated-position-evaluator.js";
import { childLogger } from "../utils/logger.js";
import { computedIlLossUsd, normalizeIlLossUsd } from "../utils/pnl.js";

const log = childLogger("position-evaluator");

export interface PositionEvaluatorOptions {
  actions: MeteoraActions;
  meteora: MeteoraTools;
  jupiter: JupiterTools;
  /** Optional. When provided, evaluations include `remoteMeteoraPnl`. */
  pnl?: MeteoraPnlTools;
  /** Window length (minutes) for inRangePct rolling calculation. Default 60. */
  samplingWindowMinutes?: number;
  /** Passed through to SimulatedPositionEvaluator. */
  managerConfig?: Pick<ManagerConfig, "estimatedProviders">;
}

interface RangeSample {
  ts: number;
  inRange: boolean;
}

export class PositionEvaluator {
  private readonly actions: MeteoraActions;
  private readonly jupiter: JupiterTools;
  private readonly pnl?: MeteoraPnlTools;
  private readonly samplingWindowMs: number;
  private readonly samples = new Map<string, RangeSample[]>();
  private readonly simulatedEvaluator: SimulatedPositionEvaluator;

  constructor(opts: PositionEvaluatorOptions) {
    this.actions = opts.actions;
    this.jupiter = opts.jupiter;
    this.pnl = opts.pnl;
    const minutes = opts.samplingWindowMinutes ?? 60;
    this.samplingWindowMs = Math.max(1, minutes) * 60_000;
    this.simulatedEvaluator = new SimulatedPositionEvaluator(
      opts.meteora,
      opts.jupiter,
      opts.managerConfig ?? {},
    );
  }

  async evaluate(position: Position): Promise<PositionEvaluation | null> {
    if (position.dryRun) {
      return this.simulatedEvaluator.evaluate(position);
    }
    // 1. Fetch on-chain state.
    let onChain: Awaited<ReturnType<MeteoraActions["fetchPositionState"]>> =
      null;
    try {
      onChain = await this.actions.fetchPositionState(
        position.positionPubkey,
        position.poolAddress,
      );
    } catch (err) {
      log.warn(
        {
          positionPubkey: position.positionPubkey,
          err: err instanceof Error ? err.message : String(err),
        },
        "fetchPositionState threw",
      );
      onChain = null;
    }
    if (!onChain) {
      log.warn(
        { positionPubkey: position.positionPubkey },
        "on-chain state unavailable, cannot evaluate",
      );
      return null;
    }

    // 2. Fetch USD prices.
    let prices: Record<string, number> = {};
    try {
      prices = await this.jupiter.getPriceUsd([
        position.tokenX.mint,
        position.tokenY.mint,
      ]);
    } catch (err) {
      log.warn(
        {
          positionPubkey: position.positionPubkey,
          err: err instanceof Error ? err.message : String(err),
        },
        "price lookup failed, using zero prices",
      );
      prices = {};
    }
    const priceX = prices[position.tokenX.mint] ?? 0;
    const priceY = prices[position.tokenY.mint] ?? 0;

    // 3. Convert raw amounts to UI amounts.
    const uiAmountX = rawToUi(onChain.amountX, position.tokenX.decimals);
    const uiAmountY = rawToUi(onChain.amountY, position.tokenY.decimals);
    const uiFeeX = rawToUi(onChain.claimableFeeX, position.tokenX.decimals);
    const uiFeeY = rawToUi(onChain.claimableFeeY, position.tokenY.decimals);

    const currentValueUsd = uiAmountX * priceX + uiAmountY * priceY;

    const claimableFees: ClaimableFees = {
      tokenX: onChain.claimableFeeX,
      tokenY: onChain.claimableFeeY,
      usdValue: uiFeeX * priceX + uiFeeY * priceY,
    };

    // 4. In-range calculation + sampling.
    const inRange =
      onChain.activeBinId >= position.lowerBinId &&
      onChain.activeBinId <= position.upperBinId;

    const now = Date.now();
    this.recordSample(position.positionPubkey, now, inRange);
    const inRangePct = this.computeInRangePct(position.positionPubkey, now);
    const outOfRangeMinutes = this.computeOutOfRangeMinutes(
      position.positionPubkey,
      position.entryTimestamp,
      now,
      inRange,
    );

    // 5. Age + PnL + IL.
    const ageMinutes = Math.max(0, (now - position.entryTimestamp) / 60_000);
    let pnlUsd = currentValueUsd - position.entryValueUsd + claimableFees.usdValue;
    const entryUiX = rawToUi(position.entryAmountX, position.tokenX.decimals);
    const entryUiY = rawToUi(position.entryAmountY, position.tokenY.decimals);
    const hodlValueUsd = entryUiX * priceX + entryUiY * priceY;
    let ilUsd = computedIlLossUsd(hodlValueUsd - currentValueUsd);

    // 6. Remote PnL (Meteora official PnL API). Prefer when available because
    //    it accounts for fees already claimed and historical deposits.
    let remoteMeteoraPnl: RemoteMeteoraPnl | undefined;
    if (this.pnl) {
      try {
        const remote = await this.pnl.getPositionPnl(position.positionPubkey);
        if (remote) {
          remoteMeteoraPnl = remote;
          if (Number.isFinite(remote.totalPnlUsd)) {
            pnlUsd = remote.totalPnlUsd;
          }
          if (Number.isFinite(remote.impermanentLossUsd)) {
            ilUsd = normalizeIlLossUsd(remote.impermanentLossUsd);
          }
          // Overlay unclaimed fees from authoritative source when present.
          if (Number.isFinite(remote.unclaimedFeeUsd)) {
            claimableFees.usdValue = remote.unclaimedFeeUsd;
          }
        }
      } catch (err) {
        log.debug(
          {
            positionPubkey: position.positionPubkey,
            err: err instanceof Error ? err.message : String(err),
          },
          "meteora pnl api lookup failed",
        );
      }
    }
    const pnlPct =
      position.entryValueUsd > 0 ? pnlUsd / position.entryValueUsd : 0;

    // 7. Current price: prefer ratio derived from on-chain prices if both available.
    const currentPrice = priceY > 0 ? priceX / priceY : position.entryPrice;

    const evaluation: PositionEvaluation = {
      position,
      evaluatedAt: now,
      currentActiveBinId: onChain.activeBinId,
      inRange,
      inRangePct,
      outOfRangeMinutes,
      currentPrice,
      currentAmountX: onChain.amountX,
      currentAmountY: onChain.amountY,
      currentValueUsd,
      claimableFees,
      pnlUsd,
      pnlPct,
      ilUsd,
      ageMinutes,
    };
    if (remoteMeteoraPnl) evaluation.remoteMeteoraPnl = remoteMeteoraPnl;
    return evaluation;
  }

  private recordSample(
    positionPubkey: string,
    ts: number,
    inRange: boolean,
  ): void {
    const existing = this.samples.get(positionPubkey) ?? [];
    existing.push({ ts, inRange });
    const cutoff = ts - this.samplingWindowMs;
    const trimmed = existing.filter((s) => s.ts >= cutoff);
    this.samples.set(positionPubkey, trimmed);
  }

  private computeInRangePct(positionPubkey: string, _now: number): number {
    const arr = this.samples.get(positionPubkey) ?? [];
    if (arr.length === 0) return 1;
    const inCount = arr.reduce((acc, s) => acc + (s.inRange ? 1 : 0), 0);
    return inCount / arr.length;
  }

  private computeOutOfRangeMinutes(
    positionPubkey: string,
    entryTimestamp: number,
    now: number,
    currentlyInRange: boolean,
  ): number {
    if (currentlyInRange) return 0;
    const arr = this.samples.get(positionPubkey) ?? [];
    // Find most recent in-range sample BEFORE now.
    let lastInRangeTs: number | null = null;
    for (let i = arr.length - 1; i >= 0; i--) {
      const s = arr[i];
      if (s && s.inRange) {
        lastInRangeTs = s.ts;
        break;
      }
    }
    if (lastInRangeTs === null) {
      // Never seen in-range during sampling window → use age since entry.
      return Math.max(0, (now - entryTimestamp) / 60_000);
    }
    return Math.max(0, (now - lastInRangeTs) / 60_000);
  }
}

function rawToUi(raw: string, decimals: number): number {
  if (!raw || raw === "0") return 0;
  try {
    const big = BigInt(raw);
    if (big === 0n) return 0;
    const divisor = 10n ** BigInt(Math.max(0, decimals));
    const whole = big / divisor;
    const remainder = big % divisor;
    // Combine whole + fractional via string to avoid intermediate Number overflow.
    if (decimals <= 0) return Number(whole);
    const fracStr = remainder.toString().padStart(decimals, "0");
    const combined = `${whole.toString()}.${fracStr}`;
    const n = Number(combined);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
