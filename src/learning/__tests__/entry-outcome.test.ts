import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EntryOutcomeComputer } from "../entry-outcome.js";
import type { LearningDecision, Pool } from "../../types/index.js";
import type { MeteoraTools } from "../../tools/meteora.tools.js";

const BASE_POOL: Pool = {
  address: "pool-1",
  name: "ALPHA-SOL",
  tokenX: { mint: "alpha", symbol: "ALPHA", decimals: 6 },
  tokenY: { mint: "sol", symbol: "SOL", decimals: 9 },
  binStep: 100,
  baseFeeBps: 100,
  tvl: 20_000,
  activeTvl: 10_000,
  volume24h: 2_000,
  fees24h: 20,
  activeBinId: 103,
  currentPrice: 1.1,
};

function decision(features: LearningDecision["features"]): LearningDecision {
  return {
    id: "ld-1",
    kind: "screener",
    timestamp: Date.now(),
    pool: { address: "pool-1", name: "ALPHA-SOL" },
    action: "ENTER",
    reasons: [],
    risks: [],
    features,
  };
}

// `enriched === null` simulates on-chain enrichment failing (returns {}); the
// default mirrors the fetched pool's on-chain active-bin basis so priceReturn and
// drift are measured against a consistent basis (the fixed production path).
function computer(
  pool: Pool,
  enriched?: Partial<Pool> | null,
): EntryOutcomeComputer {
  const enrichResult: Partial<Pool> =
    enriched === null
      ? {}
      : (enriched ?? {
          activeBinId: pool.activeBinId,
          currentPrice: pool.currentPrice,
        });
  return new EntryOutcomeComputer({
    meteora: {
      fetchPairByAddress: async () => pool,
      enrichOnChain: async () => enrichResult,
    } as unknown as MeteoraTools,
  });
}

describe("EntryOutcomeComputer", () => {
  it("computes priceReturn from captured entry price", async () => {
    const outcome = await computer(BASE_POOL).compute(
      decision({
        entryPrice: 1,
        activeBinId: 100,
        feeOverActiveTvl: 0.001,
        volumeOverTvl: 0.05,
      }),
      30,
    );

    assert.ok(Math.abs((outcome.priceReturn ?? 0) - 0.1) < 1e-9);
    assert.ok(outcome.netPnlRiskScore > 0);
  });

  it("uses range bins per side to flag relevant active-bin drift", async () => {
    const outcome = await computer({ ...BASE_POOL, activeBinId: 104 }).compute(
      decision({
        entryPrice: 1,
        activeBinId: 100,
        rangeBinsPerSide: 3,
        feeOverActiveTvl: 0.001,
      }),
      30,
    );

    assert.equal(outcome.activeBinDrift, 4);
    assert.ok(outcome.riskFlagsTripped.includes("active_bin_drifted_out"));
  });

  it("drops priceReturn and drift, flags unmeasurable, when on-chain enrichment fails", async () => {
    // No on-chain basis → cross-API price/bin comparison is meaningless. Must NOT
    // emit a fabricated ~-1 priceReturn or a false-positive drift, and must settle
    // near-neutral rather than pinned toxic.
    const outcome = await computer(
      { ...BASE_POOL, activeBinId: 0 },
      null,
    ).compute(
      decision({
        entryPrice: 1,
        activeBinId: 100,
        feeOverActiveTvl: 0.001,
      }),
      30,
    );

    assert.equal(outcome.priceReturn, undefined);
    assert.equal(outcome.activeBinDrift, undefined);
    assert.ok(outcome.riskFlagsTripped.includes("price_basis_unmeasurable"));
    assert.ok(!outcome.riskFlagsTripped.includes("active_bin_drifted_out"));
    assert.ok(
      outcome.netPnlRiskScore > -0.5,
      "unmeasurable should not pin toxic",
    );
  });

  it("does NOT cap a real on-chain crash", async () => {
    // When the on-chain basis IS present and price genuinely collapsed, the score
    // must reflect it — the fix removes the false -1, it does not mute true crashes.
    const outcome = await computer({
      ...BASE_POOL,
      activeBinId: 100,
      currentPrice: 0.1,
    }).compute(
      decision({ entryPrice: 1, activeBinId: 100, feeOverActiveTvl: 0.5 }),
      30,
    );

    assert.ok((outcome.priceReturn ?? 0) < -0.85);
    assert.ok(outcome.netPnlRiskScore < -0.5);
  });
});
