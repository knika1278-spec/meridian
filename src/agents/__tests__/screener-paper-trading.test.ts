import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ScreenerAgent, type ScreenerDeps } from "../screener.agent.js";
import type { ManagerAgent } from "../manager.agent.js";
import { DEFAULT_ENTRY_POLICY } from "../../utils/entry-policy.js";
import type {
  OpenPositionInput,
  Pool,
  Position,
  ScreeningResult,
  UserConfig,
} from "../../types/index.js";

describe("ScreenerAgent dry-run paper handoff", () => {
  it("records WOULD_OPEN and opens at most one paper position", async () => {
    const openInputs: OpenPositionInput[] = [];
    const journalEvents: Array<{ event: string; reasons?: string[] }> = [];
    const manager = {
      openPaper: async (input: OpenPositionInput) => {
        openInputs.push(input);
        return makePosition(input.poolAddress);
      },
    } as unknown as ManagerAgent;
    const screener = new ScreenerAgent(makeConfig(), {
      decisionLogger: { append: () => undefined },
      meteora: {},
      jupiter: {},
      manager,
      decisionJournal: {
        safeAppend: (entry: { event: string; reasons?: string[] }) => {
          journalEvents.push(entry);
        },
      },
    } as unknown as ScreenerDeps);

    await (
      screener as unknown as {
        autoOpenEnterDecisions(
          results: ScreeningResult[],
          cycleId: string,
        ): Promise<void>;
      }
    ).autoOpenEnterDecisions(
      [makeResult("pool-best", 0.86), makeResult("pool-second", 0.74)],
      "cycle-1",
    );

    assert.equal(openInputs.length, 1);
    assert.equal(openInputs[0]?.poolAddress, "pool-best");
    assert.equal(openInputs[0]?.paper, true);
    assert.equal(openInputs[0]?.dryRun, true);
    assert.ok(openInputs[0]?.entrySnapshot);
    assert.equal(openInputs[0]?.entrySnapshot?.realtimeEvents?.length, 3);
    assert.equal(
      openInputs[0]?.entrySnapshot?.realtimeEvents?.every(
        (event) => event.poolAddress === "pool-best",
      ),
      true,
    );
    assert.equal(
      journalEvents.filter((event) => event.event === "WOULD_OPEN").length,
      1,
    );
    assert.equal(
      journalEvents.some(
        (event) =>
          event.event === "NO_DEPLOY" &&
          event.reasons?.includes("not_top_ranked"),
      ),
      true,
    );
  });

  it("does not block a low-confidence LLM ENTER with a numeric confidence gate", async () => {
    const openInputs: OpenPositionInput[] = [];
    const journalEvents: Array<{ event: string; reasons?: string[] }> = [];
    const manager = {
      openPaper: async (input: OpenPositionInput) => {
        openInputs.push(input);
        return makePosition(input.poolAddress);
      },
    } as unknown as ManagerAgent;
    const screener = new ScreenerAgent(makeConfig(), {
      decisionLogger: { append: () => undefined },
      meteora: {},
      jupiter: {},
      manager,
      decisionJournal: {
        safeAppend: (entry: { event: string; reasons?: string[] }) => {
          journalEvents.push(entry);
        },
      },
    } as unknown as ScreenerDeps);

    await (
      screener as unknown as {
        autoOpenEnterDecisions(
          results: ScreeningResult[],
          cycleId: string,
        ): Promise<void>;
      }
    ).autoOpenEnterDecisions([makeResult("pool-low-conf", 0.62)], "cycle-2");

    assert.equal(openInputs.length, 1);
    assert.equal(openInputs[0]?.poolAddress, "pool-low-conf");
    assert.equal(
      journalEvents.some(
        (event) =>
          event.event === "NO_DEPLOY" &&
          event.reasons?.some((reason) => /confidence/i.test(reason)),
      ),
      false,
    );
  });

  it("records LLM ENTER but blocks deploy when collapse guard fails", async () => {
    const openInputs: OpenPositionInput[] = [];
    const journalEvents: Array<{ event: string; reasons?: string[] }> = [];
    const manager = {
      openPaper: async (input: OpenPositionInput) => {
        openInputs.push(input);
        return makePosition(input.poolAddress);
      },
    } as unknown as ManagerAgent;
    const screener = new ScreenerAgent(makeConfig(), {
      decisionLogger: { append: () => undefined },
      meteora: {},
      jupiter: {},
      manager,
      decisionJournal: {
        safeAppend: (entry: { event: string; reasons?: string[] }) => {
          journalEvents.push(entry);
        },
      },
    } as unknown as ScreenerDeps);
    const result = makeResult("pool-collapse", 0.68);
    result.pool.tokenX.risk = {
      ...(result.pool.tokenX.risk ?? { flags: [] }),
      devSoldAll: true,
    };

    await (
      screener as unknown as {
        autoOpenEnterDecisions(
          results: ScreeningResult[],
          cycleId: string,
        ): Promise<void>;
      }
    ).autoOpenEnterDecisions([result], "cycle-3");

    assert.equal(openInputs.length, 0);
    assert.equal(
      journalEvents.some(
        (event) =>
          event.event === "NO_DEPLOY" &&
          event.reasons?.some((reason) => /collapse_guard_failed/.test(reason)),
      ),
      true,
    );
  });
});

function makeConfig(): UserConfig {
  return {
    dryRun: true,
    llm: {
      provider: "claude-cli",
      model: "test",
      temperature: 0,
      maxTokens: 1,
      enabled: false,
    },
    entryPolicy: {
      ...JSON.parse(JSON.stringify(DEFAULT_ENTRY_POLICY)),
      maxDeploysPerCycle: 1,
      collapseGuard: {
        ...JSON.parse(JSON.stringify(DEFAULT_ENTRY_POLICY.collapseGuard)),
        blockDevSoldAll: true,
      },
    },
    paperTrading: {
      enabled: true,
      openOnDryRun: true,
      maxOpenPositions: 3,
      openMode: "fresh_snapshot",
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
      includedTokens: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    },
    manager: {
      enabled: true,
      cron: "*/5 * * * *",
      useLlm: false,
      maxOpenPositions: 3,
      thresholds: {
        claimMinUsd: 999,
        outOfRangeMaxMinutes: 999,
        maxIlUsd: 9999,
        minTimeBeforeRebalanceMinutes: 0,
      },
      positionsFile: "./data/positions.json",
      closedPositionsFile: "./data/closed.json",
      lessonsFile: "./data/lessons.json",
      lessonsContextLimit: 0,
      positionSizeUsd: 42,
      defaultRangeBps: 1_000,
    },
  } as unknown as UserConfig;
}

function makeResult(poolAddress: string, confidence: number): ScreeningResult {
  const pool = makePool(poolAddress);
  return {
    pool,
    filtersPassed: true,
    filterReport: {},
    realtimeSignals: [
      { kind: "swap", poolAddress, slot: 1, timestamp: Date.now() - 2_000 },
      { kind: "swap", poolAddress, slot: 2, timestamp: Date.now() - 1_000 },
      { kind: "swap", poolAddress, slot: 2, timestamp: Date.now() },
    ],
    entryPolicy: {
      passed: true,
      reasons: ["entry policy passed"],
      risks: [],
      realtime: {
        total: 3,
        swaps: 3,
        liquidityAdds: 0,
        liquidityRemoves: 0,
        volumeSpikes: 0,
        activeBinChanges: 0,
        distinctSlots: 2,
        latestSignalTimestamp: Date.now(),
        latestSignalAgeMs: 0,
      },
    },
    decision: {
      action: "ENTER",
      confidence,
      reasons: ["good setup"],
      risks: [],
      suggestedSizeUsd: 50,
      suggestedRangeBps: 1_000,
    },
    timestamp: Date.now(),
    cycleId: "cycle-1",
  };
}

function makePool(address: string): Pool {
  return {
    address,
    name: `${address}-USDC`,
    tokenX: {
      mint: `${address}-mint`,
      symbol: address.toUpperCase(),
      decimals: 6,
      priceUsd: 2,
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
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
      decimals: 6,
      priceUsd: 1,
    },
    binStep: 100,
    baseFeeBps: 1,
    tvl: 20_000,
    activeTvl: 10_000,
    volume24h: 1_000,
    fees24h: 10,
    activeBinId: 100,
    currentPrice: 2,
  };
}

function makePosition(poolAddress: string): Position {
  return {
    positionPubkey: `paper-${poolAddress}`,
    poolAddress,
    poolName: `${poolAddress}-USDC`,
    tokenX: { mint: `${poolAddress}-mint`, symbol: poolAddress, decimals: 6 },
    tokenY: {
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
      decimals: 6,
    },
    binStep: 100,
    lowerBinId: 95,
    upperBinId: 105,
    entryActiveBinId: 100,
    entryPrice: 2,
    entryTimestamp: Date.now(),
    entryAmountX: "0",
    entryAmountY: "42000000",
    entryValueUsd: 42,
    strategyType: "Spot",
    dryRun: true,
  };
}
