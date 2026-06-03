import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PublicKey } from "@solana/web3.js";

import { ManagerAgent, type ManagerDeps } from "../manager.agent.js";
import { PositionTracker } from "../position-tracker.js";
import { ClosedPositionStore } from "../closed-position-store.js";
import { LessonStore } from "../lesson-store.js";
import { DEFAULT_ENTRY_POLICY } from "../../utils/entry-policy.js";
import type { LlmProvider } from "../../llm/types.js";
import type { MeteoraTools } from "../../tools/meteora.tools.js";
import type { JupiterTools } from "../../tools/jupiter.tools.js";
import type { MeteoraActions } from "../../tools/meteora-actions.tools.js";
import type { WalletTools } from "../../tools/wallet.tools.js";
import type { RealtimeListener } from "../realtime.listener.js";
import type {
  EntryRealtimeEvent,
  EntrySnapshot,
  Pool,
  Position,
  PositionEvaluation,
  RealtimeEvent,
  UserConfig,
} from "../../types/index.js";

describe("ManagerAgent paper trading", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-paper-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it("openPaper creates a dry-run position without calling actions.openPosition", async () => {
    const pool = makePool();
    const { manager, tracker, calls } = makeManager({ dir, pool });

    const opened = await manager.openPaper(
      {
        poolAddress: pool.address,
        sizeUsd: 123,
        rangeBps: 1_000,
        dryRun: true,
        paper: true,
        cycleIdOnEnter: "cycle-1",
        entrySnapshot: makeEntrySnapshot(pool),
        notes: "auto-enter cycleId=cycle-1 paper=true",
      },
      { cycleId: "cycle-1" },
    );

    assert.ok(opened);
    assert.equal(opened.dryRun, true);
    assert.equal(opened.entryValueUsd, 123);
    assert.equal(opened.entrySnapshot?.poolAddress, pool.address);
    assert.match(opened.positionPubkey, /^paper-/);
    assert.equal(opened.entryAmountX, "0");
    assert.notEqual(opened.entryAmountY, "0");
    assert.equal(tracker.count(), 1);
    assert.equal(calls.openPosition, 0);
  });

  it("openPaper records no position when fresh validation fails", async () => {
    const pool = makePool();
    const { manager, tracker, calls } = makeManager({ dir, pool });
    const staleSnapshot = {
      ...makeEntrySnapshot(pool),
      decisionTimestamp: Date.now() - 120_000,
    };

    const opened = await manager.openPaper(
      {
        poolAddress: pool.address,
        sizeUsd: 100,
        rangeBps: 1_000,
        dryRun: true,
        paper: true,
        cycleIdOnEnter: "cycle-1",
        entrySnapshot: staleSnapshot,
        notes: "auto-enter cycleId=cycle-1 paper=true",
      },
      { cycleId: "cycle-1" },
    );

    assert.equal(opened, null);
    assert.equal(tracker.count(), 0);
    assert.equal(calls.openPosition, 0);
  });

  it("openPaper uses entry snapshot realtime events when manager listener is empty", async () => {
    const pool = makePool();
    const { manager, tracker, calls } = makeManager({
      dir,
      pool,
      realtimeEvents: [],
    });

    const opened = await manager.openPaper(
      {
        poolAddress: pool.address,
        sizeUsd: 100,
        rangeBps: 1_000,
        dryRun: true,
        paper: true,
        cycleIdOnEnter: "cycle-1",
        entrySnapshot: makeEntrySnapshot(pool, {
          realtimeEvents: makeRealtimeEvents(pool.address),
        }),
        notes: "auto-enter cycleId=cycle-1 paper=true",
      },
      { cycleId: "cycle-1" },
    );

    assert.ok(opened);
    assert.equal(tracker.count(), 1);
    assert.equal(calls.openPosition, 0);
  });

  it("openPaper rejects stale entry snapshot realtime events", async () => {
    const pool = makePool();
    const { manager, tracker } = makeManager({
      dir,
      pool,
      realtimeEvents: [],
    });
    const staleAt = Date.now() - 240_000;

    const opened = await manager.openPaper(
      {
        poolAddress: pool.address,
        sizeUsd: 100,
        rangeBps: 1_000,
        dryRun: true,
        paper: true,
        cycleIdOnEnter: "cycle-1",
        entrySnapshot: makeEntrySnapshot(pool, {
          realtimeEvents: [
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 1,
              timestamp: staleAt,
            },
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 2,
              timestamp: staleAt,
            },
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 2,
              timestamp: staleAt,
            },
          ],
        }),
        notes: "auto-enter cycleId=cycle-1 paper=true",
      },
      { cycleId: "cycle-1" },
    );

    assert.equal(opened, null);
    assert.equal(tracker.count(), 0);
  });

  it("openPaper rejects command realtime events that are only a one-slot burst", async () => {
    const pool = makePool();
    const { manager, tracker } = makeManager({
      dir,
      pool,
      realtimeEvents: [],
    });
    const now = Date.now();

    const opened = await manager.openPaper(
      {
        poolAddress: pool.address,
        sizeUsd: 100,
        rangeBps: 1_000,
        dryRun: true,
        paper: true,
        cycleIdOnEnter: "cycle-1",
        entrySnapshot: makeEntrySnapshot(pool, {
          realtimeEvents: [
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 1,
              timestamp: now - 2_000,
            },
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 1,
              timestamp: now - 1_000,
            },
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 1,
              timestamp: now,
            },
          ],
        }),
        notes: "auto-enter cycleId=cycle-1 paper=true",
      },
      { cycleId: "cycle-1" },
    );

    assert.equal(opened, null);
    assert.equal(tracker.count(), 0);
  });

  it("openPaper rejects command realtime events with too few swaps", async () => {
    const pool = makePool();
    const { manager, tracker } = makeManager({
      dir,
      pool,
      realtimeEvents: [],
    });
    const now = Date.now();

    const opened = await manager.openPaper(
      {
        poolAddress: pool.address,
        sizeUsd: 100,
        rangeBps: 1_000,
        dryRun: true,
        paper: true,
        cycleIdOnEnter: "cycle-1",
        entrySnapshot: makeEntrySnapshot(pool, {
          realtimeEvents: [
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 1,
              timestamp: now - 1_000,
            },
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 2,
              timestamp: now,
            },
          ],
        }),
        notes: "auto-enter cycleId=cycle-1 paper=true",
      },
      { cycleId: "cycle-1" },
    );

    assert.equal(opened, null);
    assert.equal(tracker.count(), 0);
  });

  it("openPaper rejects command realtime events with dominant liquidity remove", async () => {
    const pool = makePool();
    const { manager, tracker } = makeManager({
      dir,
      pool,
      realtimeEvents: [],
    });
    const now = Date.now();

    const opened = await manager.openPaper(
      {
        poolAddress: pool.address,
        sizeUsd: 100,
        rangeBps: 1_000,
        dryRun: true,
        paper: true,
        cycleIdOnEnter: "cycle-1",
        entrySnapshot: makeEntrySnapshot(pool, {
          realtimeEvents: [
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 1,
              timestamp: now - 4_000,
            },
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 2,
              timestamp: now - 3_000,
            },
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 2,
              timestamp: now - 2_000,
            },
            {
              kind: "liquidity_remove",
              poolAddress: pool.address,
              slot: 3,
              timestamp: now - 1_000,
            },
            {
              kind: "liquidity_remove",
              poolAddress: pool.address,
              slot: 4,
              timestamp: now,
            },
          ],
        }),
        notes: "auto-enter cycleId=cycle-1 paper=true",
      },
      { cycleId: "cycle-1" },
    );

    assert.equal(opened, null);
    assert.equal(tracker.count(), 0);
  });

  it("openPaper rejects collapse-guard failures", async () => {
    const safe = makePool();
    const pool = makePool({
      tokenX: {
        ...safe.tokenX,
        risk: {
          ...(safe.tokenX.risk ?? { flags: [] }),
          devSoldAll: true,
        },
      },
    });
    const { manager, tracker, calls } = makeManager({ dir, pool });

    const opened = await manager.openPaper(
      {
        poolAddress: pool.address,
        sizeUsd: 100,
        rangeBps: 1_000,
        dryRun: true,
        paper: true,
        cycleIdOnEnter: "cycle-1",
        entrySnapshot: makeEntrySnapshot(pool),
        notes: "auto-enter cycleId=cycle-1 paper=true",
      },
      { cycleId: "cycle-1" },
    );

    assert.equal(opened, null);
    assert.equal(tracker.count(), 0);
    assert.equal(calls.openPosition, 0);
  });

  it("openPaper rejects micro active-bin drift", async () => {
    const pool = makePool();
    const { manager, tracker } = makeManager({
      dir,
      pool,
      microStabilityDelayMs: 1,
      enrichOnChainResults: [
        { activeBinId: pool.activeBinId, currentPrice: pool.currentPrice },
        { activeBinId: pool.activeBinId + 5, currentPrice: pool.currentPrice },
      ],
    });

    const opened = await manager.openPaper(
      {
        poolAddress: pool.address,
        sizeUsd: 100,
        rangeBps: 1_000,
        dryRun: true,
        paper: true,
        cycleIdOnEnter: "cycle-1",
        entrySnapshot: makeEntrySnapshot(pool),
        notes: "auto-enter cycleId=cycle-1 paper=true",
      },
      { cycleId: "cycle-1" },
    );

    assert.equal(opened, null);
    assert.equal(tracker.count(), 0);
  });

  it("openPaper rejects micro price movement", async () => {
    const pool = makePool();
    const { manager, tracker } = makeManager({
      dir,
      pool,
      microStabilityDelayMs: 1,
      enrichOnChainResults: [
        { activeBinId: pool.activeBinId, currentPrice: pool.currentPrice },
        {
          activeBinId: pool.activeBinId,
          currentPrice: pool.currentPrice * 1.1,
        },
      ],
    });

    const opened = await manager.openPaper(
      {
        poolAddress: pool.address,
        sizeUsd: 100,
        rangeBps: 1_000,
        dryRun: true,
        paper: true,
        cycleIdOnEnter: "cycle-1",
        entrySnapshot: makeEntrySnapshot(pool),
        notes: "auto-enter cycleId=cycle-1 paper=true",
      },
      { cycleId: "cycle-1" },
    );

    assert.equal(opened, null);
    assert.equal(tracker.count(), 0);
  });

  it("openPaper ignores command realtime events more than 5s in the future", async () => {
    const pool = makePool();
    const { manager, tracker } = makeManager({
      dir,
      pool,
      realtimeEvents: [],
    });
    const futureAt = Date.now() + 6_000;

    const opened = await manager.openPaper(
      {
        poolAddress: pool.address,
        sizeUsd: 100,
        rangeBps: 1_000,
        dryRun: true,
        paper: true,
        cycleIdOnEnter: "cycle-1",
        entrySnapshot: makeEntrySnapshot(pool, {
          realtimeEvents: [
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 1,
              timestamp: futureAt,
            },
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 2,
              timestamp: futureAt,
            },
            {
              kind: "swap",
              poolAddress: pool.address,
              slot: 2,
              timestamp: futureAt,
            },
          ],
        }),
        notes: "auto-enter cycleId=cycle-1 paper=true",
      },
      { cycleId: "cycle-1" },
    );

    assert.equal(opened, null);
    assert.equal(tracker.count(), 0);
  });

  it("live open ignores entry snapshot realtime event fallback", async () => {
    const pool = makePool();
    const { manager, tracker, calls } = makeManager({
      dir,
      pool,
      live: true,
      realtimeEvents: [],
    });

    const opened = await manager.open(
      {
        poolAddress: pool.address,
        sizeUsd: 100,
        rangeBps: 1_000,
        dryRun: false,
        paper: false,
        cycleIdOnEnter: "cycle-1",
        entrySnapshot: makeEntrySnapshot(pool, {
          realtimeEvents: makeRealtimeEvents(pool.address),
        }),
        notes: "auto-enter cycleId=cycle-1",
      },
      { cycleId: "cycle-1" },
    );

    assert.equal(opened, null);
    assert.equal(tracker.count(), 0);
    assert.equal(calls.openPosition, 0);
  });

  it("closes paper positions into closed history", async () => {
    const position = makePosition({ dryRun: true });
    const evaluation = makeEvaluation(position, {
      pnlUsd: -20,
      pnlPct: -0.2,
      currentValueUsd: 80,
    });
    const { manager, tracker, closedStore, calls } = makeManager({
      dir,
      pool: makePool(),
      evaluation,
    });
    tracker.add(position);

    const report = await manager.runOnce();

    assert.equal(report.closedCount, 1);
    assert.equal(tracker.count(), 0);
    assert.equal(closedStore.count(), 1);
    assert.equal(closedStore.list()[0]?.realizedPnlPct, -0.2);
    assert.equal(calls.closePosition, 0);
  });

  it("closes paper positions when normalized IL exceeds ceiling", async () => {
    const position = makePosition({ dryRun: true });
    const evaluation = makeEvaluation(position, {
      pnlUsd: 0,
      pnlPct: 0,
      ilUsd: 10_000,
      currentValueUsd: 100,
    });
    const { manager, tracker, closedStore } = makeManager({
      dir,
      pool: makePool(),
      evaluation,
    });
    tracker.add(position);

    const report = await manager.runOnce();

    assert.equal(report.closedCount, 1);
    assert.equal(tracker.count(), 0);
    assert.equal(closedStore.list()[0]?.realizedIlUsd, 10_000);
    assert.match(closedStore.list()[0]?.exitReason ?? "", /IL/);
  });

  it("does not mutate live tracked state when global dryRun simulates a close", async () => {
    const position = makePosition({ dryRun: false });
    const evaluation = makeEvaluation(position, {
      pnlUsd: -20,
      pnlPct: -0.2,
      currentValueUsd: 80,
    });
    const { manager, tracker, closedStore, calls } = makeManager({
      dir,
      pool: makePool(),
      evaluation,
    });
    tracker.add(position);

    const report = await manager.runOnce();

    assert.equal(report.closedCount, 0);
    assert.equal(tracker.count(), 1);
    assert.equal(closedStore.count(), 0);
    assert.equal(calls.closePosition, 1);
  });

  it("swaps live close proceeds back to SOL when postCloseSwap is enabled", async () => {
    const position = makePosition({ dryRun: false });
    const evaluation = makeEvaluation(position, {
      pnlUsd: -20,
      pnlPct: -0.2,
      currentValueUsd: 80,
    });
    const { manager, tracker, closedStore, calls } = makeManager({
      dir,
      pool: makePool(),
      evaluation,
      live: true,
      postCloseSwap: true,
      closeResult: {
        receivedX: "1000000",
        receivedY: "2000000",
        claimedFeeX: "500000",
        claimedFeeY: "0",
        dryRun: false,
      },
    });
    tracker.add(position);

    const report = await manager.runOnce();

    assert.equal(report.closedCount, 1);
    assert.equal(tracker.count(), 0);
    assert.equal(closedStore.count(), 1);
    assert.equal(calls.closePosition, 1);
    assert.deepEqual(calls.quoteInputs, [
      {
        inputMint: "meme",
        outputMint: "So11111111111111111111111111111111111111112",
        amount: "1500000",
        slippageBps: 100,
      },
      {
        inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        outputMint: "So11111111111111111111111111111111111111112",
        amount: "2000000",
        slippageBps: 100,
      },
    ]);
    assert.equal(calls.buildSwapTransaction, 2);
    assert.equal(calls.signAndSend, 2);
  });
});

function makeManager(args: {
  dir: string;
  pool: Pool;
  evaluation?: PositionEvaluation;
  live?: boolean;
  postCloseSwap?: boolean;
  realtimeEvents?: RealtimeEvent[];
  enrichOnChainResults?: Array<Partial<Pool>>;
  microStabilityDelayMs?: number;
  closeResult?: {
    receivedX: string;
    receivedY: string;
    claimedFeeX: string;
    claimedFeeY: string;
    dryRun: boolean;
  };
}): {
  manager: ManagerAgent;
  tracker: PositionTracker;
  closedStore: ClosedPositionStore;
  calls: {
    openPosition: number;
    closePosition: number;
    buildSwapTransaction: number;
    signAndSend: number;
    quoteInputs: Array<{
      inputMint: string;
      outputMint: string;
      amount: string;
      slippageBps: number;
    }>;
  };
} {
  const tracker = new PositionTracker({
    filePath: path.join(args.dir, "positions.json"),
  });
  const closedStore = new ClosedPositionStore({
    filePath: path.join(args.dir, "closed.json"),
  });
  const lessonStore = new LessonStore({
    filePath: path.join(args.dir, "lessons.json"),
  });
  const calls = {
    openPosition: 0,
    closePosition: 0,
    buildSwapTransaction: 0,
    signAndSend: 0,
    quoteInputs: [] as Array<{
      inputMint: string;
      outputMint: string;
      amount: string;
      slippageBps: number;
    }>,
  };
  const config = makeConfig(args.dir);
  config.dryRun = args.live ? false : true;
  if (typeof args.microStabilityDelayMs === "number") {
    config.entryPolicy.collapseGuard.microStabilityDelayMs =
      args.microStabilityDelayMs;
  }
  if (args.postCloseSwap) {
    config.manager.postCloseSwap = {
      enabled: true,
      slippageBps: 100,
      minSwapUsd: 0,
      maxPriceImpactPct: 10,
    };
  }
  const realtimeEvents =
    args.realtimeEvents ?? makeRealtimeEvents(args.pool.address);
  const enrichOnChainResults = [...(args.enrichOnChainResults ?? [])];

  const deps: ManagerDeps = {
    meteora: {
      fetchPairByAddress: async () => args.pool,
      enrichOnChain: async () => enrichOnChainResults.shift() ?? {},
    } as unknown as MeteoraTools,
    jupiter: {
      getPriceUsd: async () => ({}),
    } as unknown as JupiterTools,
    actions: {
      openPosition: async () => {
        calls.openPosition += 1;
        throw new Error("openPosition should not be called");
      },
      closePosition: async (input: { dryRun?: boolean }) => {
        calls.closePosition += 1;
        return (
          args.closeResult ?? {
            receivedX: "0",
            receivedY: "0",
            claimedFeeX: "0",
            claimedFeeY: "0",
            dryRun: input.dryRun === true,
          }
        );
      },
      claimFees: async (input: { dryRun?: boolean }) => ({
        claimedX: "0",
        claimedY: "0",
        dryRun: input.dryRun === true,
      }),
      rebalance: async () => ({
        dryRun: true,
        newPosition: makePosition({ dryRun: true, positionPubkey: "new" }),
      }),
      positionAccountExists: async () => true,
    } as unknown as MeteoraActions,
    wallet: {
      isConfigured: () => args.live === true,
      getPublicKey: () => new PublicKey("11111111111111111111111111111111"),
      getBalanceSol: async () => 10,
      signAndSend: async () => {
        calls.signAndSend += 1;
        return { signature: `swap-${calls.signAndSend}`, dryRun: false };
      },
    } as unknown as WalletTools,
    llm: {
      name: "test",
      model: "test",
      generate: async () => ({
        ok: false,
        raw: "",
        error: "disabled",
        provider: "test",
        model: "test",
      }),
    } satisfies LlmProvider,
    tracker,
    closedStore,
    lessonStore,
    evaluator: {
      evaluate: async (position: Position) =>
        args.evaluation ? { ...args.evaluation, position } : null,
    } as unknown as ManagerDeps["evaluator"],
    jupiterSwap: args.postCloseSwap
      ? ({
          getQuote: async (input: {
            inputMint: string;
            outputMint: string;
            amount: string;
            slippageBps: number;
          }) => {
            calls.quoteInputs.push(input);
            return {
              ...input,
              inAmount: input.amount,
              outAmount: "1000000",
              otherAmountThreshold: "990000",
              swapMode: "ExactIn",
              slippageBps: input.slippageBps,
              priceImpactPct: 0.01,
              routePlan: [],
              raw: {},
            };
          },
          buildSwapTransaction: async () => {
            calls.buildSwapTransaction += 1;
            return {} as never;
          },
        } as unknown as ManagerDeps["jupiterSwap"])
      : undefined,
    listener: {
      recentFor: () => realtimeEvents,
    } as unknown as RealtimeListener,
  };

  return {
    manager: new ManagerAgent(config, deps),
    tracker,
    closedStore,
    calls,
  };
}

function makeConfig(dataDir: string): UserConfig {
  return {
    dryRun: true,
    output: {
      dataDir,
      decisionLogPath: path.join(dataDir, "decisions.jsonl"),
      verbose: false,
    },
    entryPolicy: {
      ...JSON.parse(JSON.stringify(DEFAULT_ENTRY_POLICY)),
      mode: "enforce",
      collapseGuard: {
        ...JSON.parse(JSON.stringify(DEFAULT_ENTRY_POLICY.collapseGuard)),
        blockDevSoldAll: true,
        microStabilityDelayMs: 0,
      },
    },
    llm: {
      provider: "mimo",
      model: "test",
      baseUrl: "http://localhost",
      apiKey: "test",
      postMortemMaxTokens: 500,
      timeoutMs: 5_000,
    },
    paperTrading: {
      enabled: true,
      openOnDryRun: true,
      maxOpenPositions: 3,
      openMode: "fresh_snapshot",
    },
    filters: {
      feeActiveTvlRatioMin: 0.05,
      volume24hMin: 500,
      organicScoreMin: 0,
      holdersMin: 0,
      marketCapMin: 0,
      marketCapMax: 10_000_000,
      binStepMin: 80,
      binStepMax: 125,
      tvlMin: 10_000,
      tvlMax: 150_000,
      includedTokens: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
      requireRecentActivity: true,
    },
    manager: {
      enabled: true,
      cron: "*/5 * * * *",
      useLlm: false,
      maxOpenPositions: 3,
      positionsFile: path.join(dataDir, "positions.json"),
      closedPositionsFile: path.join(dataDir, "closed.json"),
      lessonsFile: path.join(dataDir, "lessons.json"),
      lessonsContextLimit: 0,
      defaultRangeBps: 1_000,
      maxBinsPerSide: 30,
      thresholds: {
        claimMinUsd: 999,
        outOfRangeMaxMinutes: 999,
        stopLossPct: -5,
        maxIlUsd: 9999,
        minTimeBeforeRebalanceMinutes: 0,
      },
    },
    safety: {
      enabled: false,
      maxSingleTradeUsd: 5,
      maxDailySpendUsd: 25,
      maxDailyTrades: 3,
      maxDailyLossUsd: 15,
      maxTotalDrawdownPct: 0.1,
      startingCapitalUsd: 100,
      circuitBreaker: { maxConsecutiveLosses: 3 },
    },
  } as unknown as UserConfig;
}

function makePool(overrides: Partial<Pool> = {}): Pool {
  return {
    address: "pool-1",
    name: "MEME-USDC",
    tokenX: {
      mint: "meme",
      symbol: "MEME",
      decimals: 6,
      priceUsd: 2,
      organicScore: 80,
      holders: 2_000,
      marketCap: 1_000_000,
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
    ...overrides,
  };
}

function makeEntrySnapshot(
  pool: Pool,
  overrides: Partial<EntrySnapshot> = {},
): EntrySnapshot {
  return {
    poolAddress: pool.address,
    poolName: pool.name,
    decisionTimestamp: Date.now(),
    activeBinId: pool.activeBinId,
    currentPrice: pool.currentPrice,
    binStep: pool.binStep,
    tvl: pool.tvl,
    activeTvl: pool.activeTvl,
    volumeWindow: pool.volume24h,
    feesWindow: pool.fees24h,
    feeActiveTvlRatioPct: (pool.fees24h / pool.activeTvl) * 100,
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
    llmConfidence: 0.8,
    ...overrides,
  };
}

function makeRealtimeEvents(poolAddress: string): EntryRealtimeEvent[] {
  const now = Date.now();
  return [
    { kind: "swap", poolAddress, slot: 1, timestamp: now - 2_000 },
    { kind: "swap", poolAddress, slot: 2, timestamp: now - 1_000 },
    { kind: "swap", poolAddress, slot: 2, timestamp: now },
  ];
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    positionPubkey: "position-1",
    poolAddress: "pool-1",
    poolName: "MEME-USDC",
    tokenX: { mint: "meme", symbol: "MEME", decimals: 6 },
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
    entryTimestamp: Date.now() - 20 * 60_000,
    entryAmountX: "0",
    entryAmountY: "100000000",
    entryValueUsd: 100,
    strategyType: "Spot",
    dryRun: true,
    ...overrides,
  };
}

function makeEvaluation(
  position: Position,
  overrides: Partial<PositionEvaluation> = {},
): PositionEvaluation {
  return {
    position,
    evaluatedAt: Date.now(),
    currentActiveBinId: 100,
    inRange: true,
    inRangePct: 1,
    outOfRangeMinutes: 0,
    currentPrice: 2,
    currentAmountX: position.entryAmountX,
    currentAmountY: position.entryAmountY,
    currentValueUsd: 100,
    claimableFees: { tokenX: "0", tokenY: "0", usdValue: 0 },
    pnlUsd: 0,
    pnlPct: 0,
    ilUsd: 0,
    ageMinutes: 20,
    ...overrides,
  };
}
