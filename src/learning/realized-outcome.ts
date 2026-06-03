// Realized outcome computer for MANAGER decisions tied to a positionPubkey.
// Prefers closed-position records; falls back to live evaluator snapshot for
// still-open positions. Returns a LearningOutcome with kind="realized" and a
// deterministic netPnlRiskScore. Never throws — guard rails return outcomes
// with riskFlagsTripped on any missing data or evaluator failure.

import type { LearningDecision, LearningOutcome } from "../types/index.js";
import type { PositionTracker } from "../agents/position-tracker.js";
import type { ClosedPositionStore } from "../agents/closed-position-store.js";
import type { PositionEvaluator } from "../agents/position-evaluator.js";
import { scoreNetPnlRisk, SCORE_VERSION } from "./score-net-pnl-risk.js";
import { childLogger } from "../utils/logger.js";
import { normalizeIlLossUsd } from "../utils/pnl.js";

const log = childLogger("realized-outcome");

const HORIZON_GRACE_MS = 5 * 60_000;

export interface RealizedOutcomeComputerOptions {
  tracker: PositionTracker;
  closedStore: ClosedPositionStore;
  evaluator: PositionEvaluator;
}

export class RealizedOutcomeComputer {
  private readonly tracker: PositionTracker;
  private readonly closedStore: ClosedPositionStore;
  private readonly evaluator: PositionEvaluator;

  constructor(opts: RealizedOutcomeComputerOptions) {
    this.tracker = opts.tracker;
    this.closedStore = opts.closedStore;
    this.evaluator = opts.evaluator;
  }

  async compute(
    decision: LearningDecision,
    horizonMinutes: number,
  ): Promise<LearningOutcome> {
    const positionPubkey = decision.positionPubkey;
    if (!positionPubkey) {
      return baseOutcome(decision, horizonMinutes, ["no_position_pubkey"], 0);
    }

    // 1. Closed path — preferred.
    const horizonWindowMs = horizonMinutes * 60_000 + HORIZON_GRACE_MS;
    const closed = this.closedStore
      .list()
      .find(
        (c) =>
          c.position.positionPubkey === positionPubkey &&
          c.closedAt >= decision.timestamp &&
          c.closedAt - decision.timestamp <= horizonWindowMs,
      );

    if (closed) {
      const realizedPnlUsd = numOrZero(closed.realizedPnlUsd);
      const realizedFeesUsd = numOrZero(closed.totalFeesUsdEarned);
      const realizedIlUsd = normalizeIlLossUsd(closed.realizedIlUsd);
      const ageMinutes = numOrZero(closed.ageMinutes);
      const outOfRangeMinutes = numOrZero(
        closed.finalEvaluation?.outOfRangeMinutes,
      );
      const positionSizeUsd = numOrZero(closed.position.entryValueUsd);
      const score = scoreNetPnlRisk({
        realizedPnlUsd,
        realizedFeesUsd,
        realizedIlUsd,
        positionSizeUsd,
        outOfRangeMinutes,
      });
      return {
        decisionId: decision.id,
        horizonMinutes,
        kind: "realized",
        evaluatedAt: Date.now(),
        realizedPnlUsd,
        realizedFeesUsd,
        realizedIlUsd,
        ageMinutes,
        outOfRangeMinutes,
        riskFlagsTripped: [],
        netPnlRiskScore: score,
        scoreVersion: SCORE_VERSION,
      };
    }

    // 2. Open path — fall back to live evaluator snapshot.
    const open = this.tracker.get(positionPubkey);
    if (open) {
      try {
        const evaluation = await this.evaluator.evaluate(open);
        if (!evaluation) {
          return baseOutcome(
            decision,
            horizonMinutes,
            ["evaluator_returned_null"],
            0,
          );
        }
        const realizedPnlUsd = numOrZero(evaluation.pnlUsd);
        const realizedFeesUsd = numOrZero(evaluation.claimableFees?.usdValue);
        const realizedIlUsd = normalizeIlLossUsd(evaluation.ilUsd);
        const ageMinutes = numOrZero(evaluation.ageMinutes);
        const outOfRangeMinutes = numOrZero(evaluation.outOfRangeMinutes);
        const positionSizeUsd = numOrZero(open.entryValueUsd);
        const score = scoreNetPnlRisk({
          realizedPnlUsd,
          realizedFeesUsd,
          realizedIlUsd,
          positionSizeUsd,
          outOfRangeMinutes,
        });
        return {
          decisionId: decision.id,
          horizonMinutes,
          kind: "realized",
          evaluatedAt: Date.now(),
          realizedPnlUsd,
          realizedFeesUsd,
          realizedIlUsd,
          ageMinutes,
          outOfRangeMinutes,
          riskFlagsTripped: [],
          netPnlRiskScore: score,
          scoreVersion: SCORE_VERSION,
        };
      } catch (err) {
        log.warn(
          {
            positionPubkey,
            decisionId: decision.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "evaluator failed in realized-outcome computation",
        );
        return baseOutcome(decision, horizonMinutes, ["evaluator_failed"], 0);
      }
    }

    // 3. Missing path — position not open and not closed within window.
    return baseOutcome(decision, horizonMinutes, ["position_missing"], 0);
  }
}

function baseOutcome(
  decision: LearningDecision,
  horizonMinutes: number,
  riskFlagsTripped: string[],
  netPnlRiskScore: number,
): LearningOutcome {
  return {
    decisionId: decision.id,
    horizonMinutes,
    kind: "realized",
    evaluatedAt: Date.now(),
    riskFlagsTripped,
    netPnlRiskScore,
    scoreVersion: SCORE_VERSION,
  };
}

function numOrZero(n: number | undefined | null): number {
  if (n === undefined || n === null) return 0;
  return Number.isFinite(n) ? n : 0;
}
