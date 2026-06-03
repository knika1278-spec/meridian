import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { evaluateSafety, type SafetySnapshot } from "../safety-gate.js";
import { TradeLedger } from "../trade-ledger.js";
import { TradingCircuitBreaker } from "../circuit-breaker.js";
import type { SafetyConfig } from "../../types/index.js";

function safetyConfig(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    enabled: true,
    maxSingleTradeUsd: 5,
    maxDailySpendUsd: 25,
    maxDailyTrades: 3,
    maxDailyLossUsd: 15,
    maxTotalDrawdownPct: 0.1,
    startingCapitalUsd: 100,
    circuitBreaker: { maxConsecutiveLosses: 3 },
    ...overrides,
  };
}

function snapshot(overrides: Partial<SafetySnapshot> = {}): SafetySnapshot {
  return {
    tradeSizeUsd: 5,
    dailySpendUsd: 0,
    dailyTradeCount: 0,
    dailyRealizedPnlUsd: 0,
    drawdownPct: 0,
    circuitHalted: false,
    circuitHaltReason: null,
    ...overrides,
  };
}

describe("evaluateSafety", () => {
  it("permits an open within all limits", () => {
    const result = evaluateSafety(safetyConfig(), snapshot());
    assert.equal(result.ok, true);
  });

  it("permits everything when disabled", () => {
    const result = evaluateSafety(
      safetyConfig({ enabled: false }),
      snapshot({ tradeSizeUsd: 1_000_000, circuitHalted: true }),
    );
    assert.equal(result.ok, true);
  });

  it("blocks when the circuit breaker is halted", () => {
    const result = evaluateSafety(
      safetyConfig(),
      snapshot({ circuitHalted: true, circuitHaltReason: "3 losses" }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "circuit_halted");
  });

  it("blocks a trade exceeding maxSingleTradeUsd", () => {
    const result = evaluateSafety(
      safetyConfig({ maxSingleTradeUsd: 5 }),
      snapshot({ tradeSizeUsd: 100 }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "max_single_trade");
  });

  it("blocks when the daily trade count is reached", () => {
    const result = evaluateSafety(
      safetyConfig({ maxDailyTrades: 3 }),
      snapshot({ dailyTradeCount: 3 }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "max_daily_trades");
  });

  it("blocks when daily spend plus this trade would exceed the cap", () => {
    const result = evaluateSafety(
      safetyConfig({ maxDailySpendUsd: 25 }),
      snapshot({ dailySpendUsd: 22, tradeSizeUsd: 5 }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "max_daily_spend");
  });

  it("blocks when daily realized loss reaches the cap", () => {
    const result = evaluateSafety(
      safetyConfig({ maxDailyLossUsd: 15 }),
      snapshot({ dailyRealizedPnlUsd: -15 }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "max_daily_loss");
  });

  it("blocks when drawdown exceeds the cap", () => {
    const result = evaluateSafety(
      safetyConfig({ maxTotalDrawdownPct: 0.1 }),
      snapshot({ drawdownPct: 0.2 }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "max_drawdown");
  });
});

describe("TradeLedger", () => {
  let dir: string;
  const DAY = 24 * 60 * 60 * 1000;
  // Fixed reference inside a UTC day, well clear of midnight boundaries.
  const T = Date.UTC(2026, 5, 2, 12, 0, 0);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trade-ledger-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  function makeLedger(now = T): TradeLedger {
    return new TradeLedger({
      filePath: path.join(dir, "trade-log.jsonl"),
      now: () => now,
    });
  }

  it("sums daily spend and counts daily opens within the UTC day", () => {
    const ledger = makeLedger();
    ledger.recordOpen({ poolAddress: "p1", poolName: "A/SOL", sizeUsd: 5 });
    ledger.recordOpen({ poolAddress: "p2", poolName: "B/SOL", sizeUsd: 7 });
    // An open from the previous UTC day must not count toward today.
    ledger.recordOpen({
      poolAddress: "p3",
      poolName: "C/SOL",
      sizeUsd: 9,
      timestamp: T - DAY,
    });

    assert.equal(ledger.getDailySpendUsd(), 12);
    assert.equal(ledger.getDailyTradeCount(), 2);
  });

  it("sums daily realized PnL within the UTC day", () => {
    const ledger = makeLedger();
    ledger.recordClose({
      poolAddress: "p1",
      poolName: "A/SOL",
      sizeUsd: 5,
      pnlUsd: -2,
    });
    ledger.recordClose({
      poolAddress: "p2",
      poolName: "B/SOL",
      sizeUsd: 5,
      pnlUsd: 3,
    });
    ledger.recordClose({
      poolAddress: "p3",
      poolName: "C/SOL",
      sizeUsd: 5,
      pnlUsd: -100,
      timestamp: T - DAY,
    });

    assert.equal(ledger.getDailyRealizedPnlUsd(), 1);
    assert.equal(ledger.getCumulativeRealizedPnlUsd(), -99);
  });

  it("computes equity drawdown from peak", () => {
    const ledger = makeLedger();
    // equity: 100 -> 120 (peak) -> 90  => dd = (120-90)/120 = 0.25
    ledger.recordClose({
      poolAddress: "p1",
      poolName: "A/SOL",
      sizeUsd: 5,
      pnlUsd: 20,
      timestamp: T - 2 * DAY,
    });
    ledger.recordClose({
      poolAddress: "p2",
      poolName: "B/SOL",
      sizeUsd: 5,
      pnlUsd: -30,
      timestamp: T - DAY,
    });
    const dd = ledger.getDrawdownPct(100);
    assert.ok(Math.abs(dd - 0.25) < 1e-9, `expected 0.25, got ${dd}`);
  });

  it("persists records across instances", () => {
    const first = makeLedger();
    first.recordOpen({ poolAddress: "p1", poolName: "A/SOL", sizeUsd: 5 });
    const second = makeLedger();
    assert.equal(second.getDailySpendUsd(), 5);
    assert.equal(second.getDailyTradeCount(), 1);
  });
});

describe("TradingCircuitBreaker", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "circuit-breaker-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  function makeBreaker(
    onHalt?: (reason: string) => void,
  ): TradingCircuitBreaker {
    return new TradingCircuitBreaker({
      filePath: path.join(dir, "circuit-breaker.json"),
      maxConsecutiveLosses: 3,
      ...(onHalt ? { onHalt } : {}),
    });
  }

  it("halts after 3 consecutive losses", () => {
    const breaker = makeBreaker();
    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    assert.equal(breaker.canTrade(), true);
    breaker.recordTrade(-1);
    assert.equal(breaker.canTrade(), false);
  });

  it("resets the loss streak on a winning trade", () => {
    const breaker = makeBreaker();
    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    breaker.recordTrade(5); // win resets streak
    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    assert.equal(breaker.canTrade(), true);
  });

  it("fires onHalt exactly once when tripping", () => {
    const reasons: string[] = [];
    const breaker = makeBreaker((reason) => reasons.push(reason));
    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    breaker.recordTrade(-1); // already halted, must not re-fire
    assert.equal(reasons.length, 1);
  });

  it("keeps the halt across a restart (new instance reads persisted state)", () => {
    const breaker = makeBreaker();
    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    assert.equal(breaker.canTrade(), false);

    const restarted = makeBreaker();
    assert.equal(
      restarted.canTrade(),
      false,
      "a restart must not silently un-halt a tripped breaker",
    );
  });

  it("resumes trading after reset", () => {
    const breaker = makeBreaker();
    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    breaker.reset();
    assert.equal(breaker.canTrade(), true);
  });

  it("auto-resets after 24 hours", () => {
    let now = 1000;
    const breaker = new TradingCircuitBreaker({
      filePath: path.join(dir, "circuit-breaker.json"),
      maxConsecutiveLosses: 3,
      resetAfterMs: 24 * 60 * 60 * 1000,
      now: () => now,
    });

    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    assert.equal(breaker.canTrade(), false);

    // 23 hours later — still halted
    now += 23 * 60 * 60 * 1000;
    assert.equal(breaker.canTrade(), false);

    // 24 hours later — auto-reset
    now += 1 * 60 * 60 * 1000;
    assert.equal(breaker.canTrade(), true);

    // State should be fully reset
    const status = breaker.status();
    assert.equal(status.halted, false);
    assert.equal(status.consecutiveLosses, 0);
  });

  it("auto-reset survives restart", () => {
    let now = 1000;
    const filePath = path.join(dir, "circuit-breaker.json");

    const breaker = new TradingCircuitBreaker({
      filePath,
      maxConsecutiveLosses: 3,
      resetAfterMs: 24 * 60 * 60 * 1000,
      now: () => now,
    });
    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    breaker.recordTrade(-1);
    assert.equal(breaker.canTrade(), false);

    // Restart after 24+ hours — new instance should also auto-reset
    now += 25 * 60 * 60 * 1000;
    const restarted = new TradingCircuitBreaker({
      filePath,
      maxConsecutiveLosses: 3,
      resetAfterMs: 24 * 60 * 60 * 1000,
      now: () => now,
    });
    assert.equal(
      restarted.canTrade(),
      true,
      "restart after 24h should auto-reset the breaker",
    );
  });
});
