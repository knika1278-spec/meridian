import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  Pool,
  RealtimeEvent,
  ScreeningResult,
  UserConfig,
} from "../../types/index.js";
import {
  DEFAULT_ENTRY_POLICY,
  analyzeActivityTrend,
  buildEntrySnapshot,
  evaluateCollapseGuard,
  evaluateEntryPolicy,
  selectTopEnterCandidates,
  validateFreshEntry,
} from "../entry-policy.js";

const NOW = 1_800_000_000_000;
const POOL = "Pool111111111111111111111111111111111111111";
const SOL = "So11111111111111111111111111111111111111112";

function event(
  kind: RealtimeEvent["kind"],
  slot: number,
  ageMs = 1_000,
): RealtimeEvent {
  return {
    kind,
    poolAddress: POOL,
    slot,
    timestamp: NOW - ageMs,
  };
}

function pool(overrides: Partial<Pool> = {}): Pool {
  return {
    address: POOL,
    name: "ALPHA-SOL",
    tokenX: {
      mint: "Alpha1111111111111111111111111111111111111",
      symbol: "ALPHA",
      name: "Alpha",
      decimals: 6,
      marketCap: 500_000,
      holders: 2_000,
      organicScore: 80,
      priceUsd: 0.001,
      risk: {
        available: true,
        flags: [],
        devSoldAll: false,
        priceVsAthPct: 80,
        devRugCount: 0,
        devTokenCount: 1,
        sniperPct: 1,
      },
    },
    tokenY: {
      mint: SOL,
      symbol: "SOL",
      name: "Wrapped SOL",
      decimals: 9,
      marketCap: 50_000_000_000,
      holders: 3_000_000,
      organicScore: 99,
      priceUsd: 100,
    },
    binStep: 100,
    baseFeeBps: 100,
    tvl: 50_000,
    activeTvl: 40_000,
    volume24h: 1_000,
    fees24h: 25,
    activeBinId: -100,
    currentPrice: 0.001,
    ...overrides,
  };
}

function config(): UserConfig {
  return {
    entryPolicy: {
      ...JSON.parse(JSON.stringify(DEFAULT_ENTRY_POLICY)),
      collapseGuard: {
        ...JSON.parse(JSON.stringify(DEFAULT_ENTRY_POLICY.collapseGuard)),
        blockDevSoldAll: true,
        requireRiskDataForEnter: true,
      },
    },
    filters: {
      feeActiveTvlRatioMin: 0.05,
      organicScoreMin: 60,
      holdersMin: 500,
      marketCapMin: 150_000,
      marketCapMax: 10_000_000,
      binStepMin: 80,
      binStepMax: 125,
      tvlMin: 10_000,
      tvlMax: 150_000,
      volume24hMin: 500,
      includedTokens: [SOL],
      excludedTokens: [],
    },
  } as unknown as UserConfig;
}

describe("entry policy realtime gate", () => {
  it("blocks empty realtime signals", () => {
    const result = evaluateEntryPolicy([], DEFAULT_ENTRY_POLICY, NOW);
    assert.equal(result.passed, false);
    assert.match(result.risks.join(" "), /no realtime/);
  });

  it("blocks swap bursts in only one slot", () => {
    const result = evaluateEntryPolicy(
      [event("swap", 1), event("swap", 1), event("swap", 1)],
      DEFAULT_ENTRY_POLICY,
      NOW,
    );
    assert.equal(result.passed, false);
    assert.match(result.risks.join(" "), /distinct realtime slots/);
  });

  it("passes 3 swaps across 2 slots", () => {
    // Spread events across time to avoid trend burst detection
    const result = evaluateEntryPolicy(
      [
        event("swap", 1, 120_000),
        event("swap", 2, 60_000),
        event("swap", 2, 1_000),
      ],
      DEFAULT_ENTRY_POLICY,
      NOW,
    );
    assert.equal(result.passed, true);
  });

  it("blocks net liquidity drain", () => {
    const result = evaluateEntryPolicy(
      [
        event("swap", 1),
        event("swap", 2),
        event("swap", 2),
        event("liquidity_remove", 3),
        event("liquidity_remove", 4),
      ],
      DEFAULT_ENTRY_POLICY,
      NOW,
    );
    assert.equal(result.passed, false);
    assert.match(result.risks.join(" "), /liquidity_remove/);
  });
});

describe("collapse guard", () => {
  it("blocks devSoldAll", () => {
    const result = evaluateCollapseGuard(
      pool({
        tokenX: {
          ...pool().tokenX,
          risk: { ...(pool().tokenX.risk ?? { flags: [] }), devSoldAll: true },
        },
      }),
      config(),
    );
    assert.equal(result.passed, false);
    assert.match(result.risks.join(" "), /dev_sold_all/);
  });

  it("allows a single prior dev rug (graduated: low score)", () => {
    const result = evaluateCollapseGuard(
      pool({
        tokenX: {
          ...pool().tokenX,
          risk: {
            ...(pool().tokenX.risk ?? { flags: [] }),
            devRugCount: 1,
          },
        },
      }),
      config(),
    );
    assert.equal(result.passed, true);
    assert.equal(result.action, "allow");
    assert.equal(result.sizeMultiplier, 1);
  });

  it("reduces size on severe ATH drawdown (score 30)", () => {
    const result = evaluateCollapseGuard(
      pool({
        tokenX: {
          ...pool().tokenX,
          risk: {
            ...(pool().tokenX.risk ?? { flags: [] }),
            priceVsAthPct: 30,
          },
        },
      }),
      config(),
    );
    assert.equal(result.passed, true);
    assert.equal(result.action, "reduce_size");
    assert.equal(result.sizeMultiplier, 0.5);
    assert.match(result.risks.join(" "), /ath_drawdown/);
  });

  it("reduces size on medium cumulative risk (score 40)", () => {
    const result = evaluateCollapseGuard(
      pool({
        tokenX: {
          ...pool().tokenX,
          risk: {
            ...(pool().tokenX.risk ?? { flags: [] }),
            devRugCount: 1,
            devTokenCount: 99,
            sniperPct: 9,
          },
        },
      }),
      config(),
    );
    assert.equal(result.passed, true);
    assert.equal(result.action, "reduce_size");
    assert.match(result.risks.join(" "), /serial_deployer/);
    assert.match(result.risks.join(" "), /sniper_concentration/);
  });

  it("blocks high cumulative risk (score >= block threshold)", () => {
    const result = evaluateCollapseGuard(
      pool({
        tokenX: {
          ...pool().tokenX,
          risk: {
            ...(pool().tokenX.risk ?? { flags: [] }),
            devRugCount: 3,
            priceVsAthPct: 40,
          },
        },
      }),
      config(),
    );
    assert.equal(result.passed, false);
    assert.equal(result.action, "block");
    assert.equal(result.sizeMultiplier, 0);
  });

  it("blocks missing OKX risk data", () => {
    const tokenX = { ...pool().tokenX };
    delete tokenX.risk;
    const result = evaluateCollapseGuard(
      pool({
        tokenX,
      }),
      config(),
    );
    assert.equal(result.passed, false);
    assert.match(result.risks.join(" "), /missing OKX risk data/);
  });
});

describe("fresh pre-open validation", () => {
  // Spread events across time to avoid trend burst detection
  const freshEvents = [
    event("swap", 1, 120_000),
    event("swap", 2, 60_000),
    event("swap", 2, 1_000),
  ];
  const snapshot = {
    poolAddress: POOL,
    poolName: "ALPHA-SOL",
    decisionTimestamp: NOW - 1_000,
    activeBinId: -100,
    currentPrice: 0.001,
    binStep: 100,
    tvl: 50_000,
    activeTvl: 40_000,
    volumeWindow: 1_000,
    feesWindow: 25,
    feeActiveTvlRatioPct: 0.0625,
    realtime: evaluateEntryPolicy(freshEvents, DEFAULT_ENTRY_POLICY, NOW)
      .realtime,
    llmConfidence: 0.8,
  };

  it("blocks stale snapshots", () => {
    const result = validateFreshEntry({
      snapshot: { ...snapshot, decisionTimestamp: NOW - 120_000 },
      freshPool: pool(),
      freshEvents,
      config: config(),
      now: NOW,
    });
    assert.equal(result.passed, false);
    assert.equal(result.reasonCode, "stale_snapshot");
  });

  it("blocks failed fresh filters", () => {
    const result = validateFreshEntry({
      snapshot,
      freshPool: pool({ volume24h: 10 }),
      freshEvents,
      config: config(),
      now: NOW,
    });
    assert.equal(result.passed, false);
    assert.equal(result.reasonCode, "fresh_filter_failed");
  });

  it("blocks active-bin drift", () => {
    const result = validateFreshEntry({
      snapshot,
      freshPool: pool({ activeBinId: -104 }),
      freshEvents,
      config: config(),
      now: NOW,
    });
    assert.equal(result.passed, false);
    assert.equal(result.reasonCode, "active_bin_drift");
  });

  it("blocks price moves beyond threshold", () => {
    const result = validateFreshEntry({
      snapshot,
      freshPool: pool({ currentPrice: 0.0011 }),
      freshEvents,
      config: config(),
      now: NOW,
    });
    assert.equal(result.passed, false);
    assert.equal(result.reasonCode, "price_moved");
  });
});

describe("entry snapshot realtime evidence", () => {
  it("carries at most 20 compact realtime events for the same pool", () => {
    const otherPool = `${POOL}Other`;
    const realtimeSignals: RealtimeEvent[] = [
      event("swap", 1),
      { ...event("swap", 1), poolAddress: otherPool },
      ...Array.from({ length: 25 }, (_, index) => ({
        ...event("swap", index + 2),
        signature: `sig-${index}`,
        metadata: { ignored: true },
      })),
    ];
    const snapshot = buildEntrySnapshot(
      {
        pool: pool(),
        filtersPassed: true,
        filterReport: {},
        realtimeSignals,
        timestamp: NOW,
        cycleId: "cycle-1",
      } as ScreeningResult,
      0.8,
      NOW,
    );

    assert.equal(snapshot.realtimeEvents?.length, 20);
    assert.equal(
      snapshot.realtimeEvents?.every((item) => item.poolAddress === POOL),
      true,
    );
    assert.equal(
      snapshot.realtimeEvents?.some(
        (item) => "metadata" in (item as unknown as Record<string, unknown>),
      ),
      false,
    );
    assert.deepEqual(snapshot.realtimeEvents?.[0]?.signature, "sig-5");
  });
});

describe("one-best-candidate selection", () => {
  it("selects only the highest-ranked ENTER candidate", () => {
    const candidates = [
      {
        pool: pool({ address: `${POOL}A`, fees24h: 10 }),
        filtersPassed: true,
        realtimeSignals: [event("swap", 1), event("swap", 2), event("swap", 2)],
        decision: { action: "ENTER" as const, confidence: 0.75, risks: [] },
      },
      {
        pool: pool({ address: `${POOL}B`, fees24h: 30 }),
        filtersPassed: true,
        realtimeSignals: [event("swap", 1), event("swap", 2), event("swap", 2)],
        decision: { action: "ENTER" as const, confidence: 0.8, risks: [] },
      },
    ];
    const selected = selectTopEnterCandidates(candidates, 1);
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.pool.address, `${POOL}B`);
  });
});

describe("activity trend detection", () => {
  // Helper: build swap events spread across a time window.
  // `distribution` is an array of swap counts per bucket.
  // Events within a bucket share the same timestamp (bucket start) so they
  // land in the correct bucket when analyzeActivityTrend re-buckets by
  // (earliest..latest) / bucketCount.
  function trendEvents(
    distribution: number[],
    windowMs = 180_000,
  ): RealtimeEvent[] {
    const bucketCount = distribution.length;
    const bucketMs = windowMs / bucketCount;
    const events: RealtimeEvent[] = [];
    for (let b = 0; b < bucketCount; b++) {
      const count = distribution[b] ?? 0;
      for (let s = 0; s < count; s++) {
        events.push({
          kind: "swap",
          poolAddress: POOL,
          slot: b * 10 + s,
          timestamp: NOW - windowMs + b * bucketMs,
        });
      }
    }
    return events;
  }

  describe("analyzeActivityTrend", () => {
    it("returns zero ratios for <2 swap events", () => {
      const result = analyzeActivityTrend([event("swap", 1)], 6, NOW);
      assert.equal(result.sustainedRatio, 0);
      assert.equal(result.burstConcentration, 0);
      assert.equal(result.isBurst, false);
    });

    it("detects sustained activity across all buckets", () => {
      // 1 swap per bucket across 6 buckets
      const events = trendEvents([1, 1, 1, 1, 1, 1]);
      const result = analyzeActivityTrend(events, 6, NOW);
      assert.equal(result.sustainedRatio, 1);
      assert.ok(result.burstConcentration < 0.5);
    });

    it("detects burst pattern (all swaps in first third)", () => {
      // 6 swaps at the same timestamp → zero window → burst
      const events = trendEvents([6, 0, 0, 0, 0, 0]);
      const result = analyzeActivityTrend(events, 6, NOW);
      assert.equal(result.sustainedRatio, 0);
      assert.equal(result.burstConcentration, 1);
    });

    it("detects burst when most swaps are in first 2 of 6 buckets", () => {
      // 5 swaps early, 1 swap late
      const events = trendEvents([3, 2, 0, 0, 0, 1]);
      const result = analyzeActivityTrend(events, 6, NOW);
      // First third = buckets [0,1] → 5/6 swaps
      assert.ok(result.burstConcentration > 0.7);
    });

    it("handles all events at same timestamp (zero window)", () => {
      const events: RealtimeEvent[] = [
        { kind: "swap", poolAddress: POOL, slot: 1, timestamp: NOW },
        { kind: "swap", poolAddress: POOL, slot: 2, timestamp: NOW },
      ];
      const result = analyzeActivityTrend(events, 6, NOW);
      assert.equal(result.burstConcentration, 1);
      assert.equal(result.isBurst, true);
    });
  });

  describe("evaluateEntryPolicy with trend", () => {
    const TREND_POLICY = {
      ...DEFAULT_ENTRY_POLICY,
      realtime: {
        ...DEFAULT_ENTRY_POLICY.realtime,
        trendBuckets: 6,
        minSustainedRatio: 0.5,
        maxBurstConcentration: 0.7,
      },
    };

    it("passes sustained activity (swaps spread across window)", () => {
      // 1 swap per bucket × 6 buckets = 6 swaps, 6 slots
      const events = trendEvents([1, 1, 1, 1, 1, 1]);
      const result = evaluateEntryPolicy(events, TREND_POLICY, NOW);
      assert.equal(result.passed, true);
      assert.equal(result.realtime.isBurst, false);
    });

    it("blocks burst pattern (all swaps in first third)", () => {
      // 6 swaps in first bucket, 0 elsewhere → burst + not sustained
      const events = trendEvents([6, 0, 0, 0, 0, 0]);
      const result = evaluateEntryPolicy(events, TREND_POLICY, NOW);
      assert.equal(result.passed, false);
      assert.equal(result.realtime.isBurst, true);
      assert.match(result.risks.join(" "), /activity burst/);
    });

    it("blocks low sustained ratio (swaps in <50% of buckets)", () => {
      // 3 swaps at same timestamp → zero window → burst (fires before sustained check)
      const events = trendEvents([3, 0, 0, 0, 0, 0]);
      const result = evaluateEntryPolicy(events, TREND_POLICY, NOW);
      assert.equal(result.passed, false);
      assert.match(result.risks.join(" "), /burst|not sustained/);
    });

    it("skips trend check when trendBuckets is undefined", () => {
      const noTrend = {
        ...DEFAULT_ENTRY_POLICY,
        realtime: { ...DEFAULT_ENTRY_POLICY.realtime, trendBuckets: undefined },
      };
      // Burst pattern but trend disabled
      const events = trendEvents([6, 0, 0, 0, 0, 0]);
      const result = evaluateEntryPolicy(events, noTrend, NOW);
      // Should still fail on distinctSlots (only 1 slot in bucket 0)
      // but NOT on burst
      const burstRisk = result.risks.some((r) => r.includes("burst"));
      assert.equal(burstRisk, false);
    });

    it("skips trend check when <2 swaps", () => {
      const events = [event("swap", 1)];
      const result = evaluateEntryPolicy(events, TREND_POLICY, NOW);
      // Should fail on minSwaps, not on trend
      const burstRisk = result.risks.some((r) => r.includes("burst"));
      assert.equal(burstRisk, false);
    });

    it("reports trend metrics in realtime summary", () => {
      const events = trendEvents([2, 2, 2, 0, 0, 0]);
      const result = evaluateEntryPolicy(events, TREND_POLICY, NOW);
      assert.ok(result.realtime.sustainedRatio !== undefined);
      assert.ok(result.realtime.burstConcentration !== undefined);
      assert.ok(result.realtime.isBurst !== undefined);
    });
  });
});
