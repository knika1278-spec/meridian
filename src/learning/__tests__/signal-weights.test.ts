import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeSignalWeights } from "../signal-weights.js";
import type { LearningDecision, LearningOutcome } from "../../types/index.js";

function decision(
  id: string,
  feeOverActiveTvl: number,
  riskFlags: string[] = [],
): LearningDecision {
  return {
    id,
    kind: "screener",
    timestamp: 1,
    pool: { address: `pool-${id}`, name: "ALPHA-SOL" },
    action: "ENTER",
    reasons: [],
    risks: [],
    features: {
      pairClass: "exotic",
      binStep: 100,
      feeOverActiveTvl,
      volumeOverTvl: 1,
      riskFlags,
    },
  };
}

function outcome(decisionId: string, score: number): LearningOutcome {
  return {
    decisionId,
    horizonMinutes: 30,
    kind: "entry_market_proxy",
    evaluatedAt: 1,
    riskFlagsTripped: [],
    netPnlRiskScore: score,
  };
}

describe("computeSignalWeights", () => {
  it("computes deterministic positive and negative lift observations", () => {
    const snapshot = computeSignalWeights(
      [
        decision("d1", 0.2),
        decision("d2", 0.18),
        decision("d3", 0.01, ["mint_authority"]),
        decision("d4", 0.02, ["mint_authority"]),
      ],
      [
        outcome("d1", 0.8),
        outcome("d2", 0.6),
        outcome("d3", -0.5),
        outcome("d4", -0.7),
      ],
      { minSamples: 2, generatedAt: 123 },
    );

    assert.equal(snapshot.generatedAt, 123);
    assert.equal(snapshot.sampleSize, 4);
    assert.equal(snapshot.topPositive[0]?.signal, "feeOverActiveTvl:high");
    assert.equal(snapshot.topPositive[0]?.lift, 1.3);
    assert.equal(snapshot.topNegative[0]?.signal, "riskFlag:mint_authority");
    assert.equal(snapshot.topNegative[0]?.lift, -1.3);
  });
});
