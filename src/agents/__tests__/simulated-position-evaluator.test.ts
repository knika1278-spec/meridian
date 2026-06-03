import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SimulatedPositionEvaluator } from "../simulated-position-evaluator.js";
import type { JupiterTools } from "../../tools/jupiter.tools.js";
import type { MeteoraTools } from "../../tools/meteora.tools.js";
import type { Pool, Position } from "../../types/index.js";

describe("SimulatedPositionEvaluator", () => {
  it("returns pnlPct as a fraction", async () => {
    const pool = makePool({
      tokenY: { ...makePool().tokenY, priceUsd: 0.9 },
      fees24h: 0,
    });
    const evaluator = new SimulatedPositionEvaluator(
      makeMeteora(pool),
      makeJupiter(),
      {},
    );

    const evaluation = await evaluator.evaluate(
      makePosition({ entryAmountY: "100000000", entryValueUsd: 100 }),
    );

    assert.ok(evaluation);
    assert.equal(evaluation.pnlUsd, -10);
    assert.equal(evaluation.pnlPct, -0.1);
  });

  it("accumulates outOfRangeMinutes from firstOutOfRangeAt", async () => {
    const now = Date.now();
    const pool = makePool({ activeBinId: 120, fees24h: 0 });
    const evaluator = new SimulatedPositionEvaluator(
      makeMeteora(pool),
      makeJupiter(),
      {},
    );

    const evaluation = await evaluator.evaluate(
      makePosition({
        sim: {
          currentValueUsd: 100,
          accruedFeesUsd: 0,
          activeBinId: 110,
          inRange: false,
          firstOutOfRangeAt: now - 5 * 60_000,
          lastUpdated: now - 60_000,
        },
      }),
    );

    assert.ok(evaluation);
    assert.equal(evaluation.inRange, false);
    assert.ok(evaluation.outOfRangeMinutes >= 4.9);
  });

  it("suppresses IL on a ~1000x price-scale glitch (no false stop-loss)", async () => {
    // entryPrice=1 (makePosition) vs currentPrice=0.001 → k=0.001 is a data/unit
    // glitch, not a real move. The guard must not turn it into a ~-94% paper loss.
    const pool = makePool({
      activeBinId: 120,
      currentPrice: 0.001,
      fees24h: 0,
    });
    const evaluator = new SimulatedPositionEvaluator(
      makeMeteora(pool),
      makeJupiter(),
      {},
    );

    const evaluation = await evaluator.evaluate(
      makePosition({ entryAmountY: "100000000", entryValueUsd: 100 }),
    );

    assert.ok(evaluation);
    assert.equal(evaluation.ilUsd, 0);
    assert.ok(
      evaluation.pnlPct > -0.5,
      `expected no catastrophic paper loss, got pnlPct ${evaluation.pnlPct}`,
    );
  });

  it("still reports meaningful IL on a legitimate deep move within band", async () => {
    // entryPrice=1 vs currentPrice=0.02 → k=0.02 (-98%) is within the plausible
    // band, so the IL model still applies.
    const pool = makePool({
      activeBinId: 120,
      currentPrice: 0.02,
      fees24h: 0,
    });
    const evaluator = new SimulatedPositionEvaluator(
      makeMeteora(pool),
      makeJupiter(),
      {},
    );

    const evaluation = await evaluator.evaluate(
      makePosition({ entryAmountY: "100000000", entryValueUsd: 100 }),
    );

    assert.ok(evaluation);
    assert.ok(
      evaluation.ilUsd > 0,
      `expected positive IL for a real move, got ${evaluation.ilUsd}`,
    );
  });
});

function makeMeteora(pool: Pool): MeteoraTools {
  return {
    fetchPairByAddress: async () => pool,
  } as unknown as MeteoraTools;
}

function makeJupiter(): JupiterTools {
  return {
    getPriceStats: async () => ({}),
  } as unknown as JupiterTools;
}

function makePool(overrides: Partial<Pool> = {}): Pool {
  return {
    address: "pool-1",
    name: "MEME-USDC",
    tokenX: {
      mint: "meme",
      symbol: "MEME",
      decimals: 6,
      priceUsd: 1,
    },
    tokenY: {
      mint: "usdc",
      symbol: "USDC",
      decimals: 6,
      priceUsd: 1,
    },
    binStep: 100,
    baseFeeBps: 1,
    tvl: 20_000,
    activeTvl: 10_000,
    volume24h: 1_000,
    fees24h: 0,
    activeBinId: 100,
    currentPrice: 1,
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    positionPubkey: "paper-position-1",
    poolAddress: "pool-1",
    poolName: "MEME-USDC",
    tokenX: { mint: "meme", symbol: "MEME", decimals: 6 },
    tokenY: { mint: "usdc", symbol: "USDC", decimals: 6 },
    binStep: 100,
    lowerBinId: 95,
    upperBinId: 105,
    entryActiveBinId: 100,
    entryPrice: 1,
    entryTimestamp: Date.now() - 10 * 60_000,
    entryAmountX: "0",
    entryAmountY: "100000000",
    entryValueUsd: 100,
    strategyType: "Spot",
    dryRun: true,
    ...overrides,
  };
}
