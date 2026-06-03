// Unit tests for scoreNetPnlRisk (SCORE_VERSION 3).
// Uses node:test runner via tsx --test.
//
// Score range is [-1, +1] (signed): >0 favorable, <0 toxic, 0 neutral.
// The task's [0,1] thresholds map via norm = (score + 1) / 2, asserted explicitly below.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scoreNetPnlRisk } from "../score-net-pnl-risk.js";

const EPS = 1e-9;
const norm = (s: number): number => (s + 1) / 2; // map [-1,1] → [0,1] (owner's scale)

function approxEqual(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < EPS,
    `expected ${actual} ≈ ${expected} (within ${EPS})`,
  );
}

describe("scoreNetPnlRisk", () => {
  // ── coercion / penalties (unchanged) ─────────────────────────────────────
  it("all undefined → 0", () => {
    approxEqual(scoreNetPnlRisk({}), 0);
  });

  it("only one riskFlag → -0.2", () => {
    approxEqual(
      scoreNetPnlRisk({ riskFlagsTripped: ["pool_unavailable"] }),
      -0.2,
    );
  });

  it("two riskFlags → -0.4", () => {
    approxEqual(scoreNetPnlRisk({ riskFlagsTripped: ["a", "b"] }), -0.4);
  });

  it("outOfRangeMinutes=120 → -0.2 (0.1 * 2)", () => {
    approxEqual(scoreNetPnlRisk({ outOfRangeMinutes: 120 }), -0.2);
  });

  it("NaN realizedPnlUsd coerced to 0", () => {
    approxEqual(
      scoreNetPnlRisk({ realizedPnlUsd: NaN, positionSizeUsd: 25 }),
      0,
    );
  });

  // ── realized branch (ground truth, untouched by [C1]) ────────────────────
  it("realized small win (pnl=5, size=25) → 0.2", () => {
    approxEqual(
      scoreNetPnlRisk({ realizedPnlUsd: 5, positionSizeUsd: 25 }),
      0.2,
    );
  });

  it("realized win with fees (pnl=5, fees=5, size=25) → 0.4", () => {
    approxEqual(
      scoreNetPnlRisk({
        realizedPnlUsd: 5,
        realizedFeesUsd: 5,
        positionSizeUsd: 25,
      }),
      0.4,
    );
  });

  it("realized loss + IL (pnl=-3, il=2, size=25) → -0.2", () => {
    approxEqual(
      scoreNetPnlRisk({
        realizedPnlUsd: -3,
        realizedIlUsd: 2,
        positionSizeUsd: 25,
      }),
      -0.2,
    );
  });

  it("normalizes legacy negative IL before scoring", () => {
    assert.ok(
      scoreNetPnlRisk({
        realizedPnlUsd: 1,
        realizedIlUsd: -37,
        positionSizeUsd: 40,
      }) < -0.8,
    );
  });

  // ── AUDIT FIX [C1] proxy invariants: the four task validation scenarios ───
  it("[C1] token down 99% (rug) → norm < 0.05 — even with fee/volume churn spike", () => {
    // fat=32 mimics the BABYTROLL rug: huge fee churn that v2 rewarded. v3 gates it to ~0.
    const s = scoreNetPnlRisk({
      priceReturn: -0.99,
      feeActiveTvlChange: 32,
      riskFlagsTripped: ["active_bin_drifted_out"],
    });
    assert.ok(
      norm(s) < 0.05,
      `down99% norm=${norm(s).toFixed(3)} should be < 0.05`,
    );
  });

  it("[C1] token down 50% → norm < 0.2", () => {
    const s = scoreNetPnlRisk({
      priceReturn: -0.5,
      feeActiveTvlChange: 0.5,
      riskFlagsTripped: ["active_bin_drifted_out"],
    });
    assert.ok(
      norm(s) < 0.2,
      `down50% norm=${norm(s).toFixed(3)} should be < 0.2`,
    );
  });

  it("[C1] token up 200%, low IL, healthy fees → norm > 0.8", () => {
    const s = scoreNetPnlRisk({ priceReturn: 2.0, feeActiveTvlChange: 0.5 });
    assert.ok(
      norm(s) > 0.8,
      `up200% norm=${norm(s).toFixed(3)} should be > 0.8`,
    );
  });

  it("[C1] flat price, fee earned → norm ≈ 0.5 (neutral-positive)", () => {
    const s = scoreNetPnlRisk({ priceReturn: 0, feeActiveTvlChange: 0.3 });
    assert.ok(
      norm(s) >= 0.5 && norm(s) <= 0.62,
      `flat norm=${norm(s).toFixed(3)} should be ≈ 0.5`,
    );
  });

  // ── directional ordering ─────────────────────────────────────────────────
  it("[C1] crash scores strictly worse than flat scores worse than pump", () => {
    const crash = scoreNetPnlRisk({
      priceReturn: -0.9,
      feeActiveTvlChange: 10,
    });
    const flat = scoreNetPnlRisk({ priceReturn: 0, feeActiveTvlChange: 0.3 });
    const pump = scoreNetPnlRisk({ priceReturn: 1.0, feeActiveTvlChange: 0.3 });
    assert.ok(crash < flat && flat < pump, `${crash} < ${flat} < ${pump}`);
  });

  it("[C1] fee churn cannot rescue a crashing token (price-gated credit)", () => {
    const noFee = scoreNetPnlRisk({ priceReturn: -0.8 });
    const bigFee = scoreNetPnlRisk({
      priceReturn: -0.8,
      feeActiveTvlChange: 100,
    });
    // A +100 fee churn during an -80% crash adds < 0.05 to the score.
    assert.ok(
      bigFee - noFee < 0.05,
      `fee churn lifted score by ${bigFee - noFee}`,
    );
  });

  it("zero priceReturn + zero feeActiveTvlChange → 0", () => {
    approxEqual(scoreNetPnlRisk({ priceReturn: 0, feeActiveTvlChange: 0 }), 0);
  });

  it("proxyWeights override defaults (priceWeight=1, feeWeight=0)", () => {
    // base = 1*priceSignal(-0.25) + 0 = -sqrt(0.25) = -0.5
    const s = scoreNetPnlRisk({
      priceReturn: -0.25,
      feeActiveTvlChange: 1,
      proxyWeights: { priceWeight: 1, feeWeight: 0 },
    });
    approxEqual(s, -0.5);
  });
});
