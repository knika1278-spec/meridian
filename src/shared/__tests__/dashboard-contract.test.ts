import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toDashboardPoolCandidate } from "../dashboard-contract.js";

describe("dashboard contract", () => {
  it("maps bot screening output into the web PoolCandidate shape", () => {
    const candidate = toDashboardPoolCandidate({
      filtersPassed: true,
      timestamp: 123,
      decision: {
        action: "WATCH",
        confidence: 0.8,
        reasons: ["wait for another cycle"],
        risks: [],
      },
      pool: {
        address: "pool",
        name: "AAA-BBB",
        tokenX: {
          mint: "aaa",
          symbol: "AAA",
          decimals: 6,
          organicScore: 90,
          holders: 1000,
        },
        tokenY: {
          mint: "bbb",
          symbol: "BBB",
          decimals: 9,
          organicScore: 50,
        },
        binStep: 25,
        baseFeeBps: 100,
        tvl: 10_000,
        activeTvl: 5_000,
        volume24h: 25_000,
        fees24h: 250,
        activeBinId: 42,
        feeApr24h: 120,
        createdAt: 100,
      },
    });

    assert.equal(candidate.status, "DECIDED");
    assert.equal(candidate.pool.baseMint, "aaa");
    assert.equal(candidate.pool.quoteMint, "bbb");
    assert.equal(candidate.pool.feeToTvlRatio, 0.05);
    assert.equal(candidate.pool.baseToken?.symbol, "AAA");
    assert.equal(candidate.organicScore, 0.7);
    assert.equal(candidate.lastUpdated, 123);
  });
});
