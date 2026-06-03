import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { PositionTracker } from "../position-tracker.js";
import type { Position, PositionLastEvaluation } from "../../types/index.js";

describe("PositionTracker canonical state", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "position-tracker-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it("persists latest evaluation in positions.json without creating a positions JSONL stream", () => {
    const positionsPath = path.join(dir, "positions.json");
    const tracker = new PositionTracker({ filePath: positionsPath });

    tracker.add(makePosition());

    const lastEvaluation: PositionLastEvaluation = {
      evaluatedAt: 1_779_636_000_000,
      currentActiveBinId: 103,
      inRange: true,
      inRangePct: 92,
      outOfRangeMinutes: 0,
      currentPrice: 1.12,
      currentAmountX: "1000",
      currentAmountY: "2000",
      currentValueUsd: 27.5,
      claimableFees: { tokenX: "2", tokenY: "3", usdValue: 0.42 },
      pnlUsd: 2.5,
      pnlPct: 10,
      ilUsd: -0.1,
      ageMinutes: 15,
    };
    tracker.update("position-1", { lastEvaluation });

    const saved = JSON.parse(fs.readFileSync(positionsPath, "utf-8"));
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].lastEvaluation, lastEvaluation);
    assert.equal(fs.existsSync(path.join(dir, "positions.jsonl")), false);
  });
});

function makePosition(): Position {
  return {
    positionPubkey: "position-1",
    poolAddress: "pool-1",
    poolName: "SOL/USDC",
    tokenX: {
      mint: "So11111111111111111111111111111111111111112",
      symbol: "SOL",
      decimals: 9,
    },
    tokenY: {
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
      decimals: 6,
    },
    binStep: 25,
    lowerBinId: 95,
    upperBinId: 105,
    entryActiveBinId: 100,
    entryPrice: 1,
    entryTimestamp: 1_779_635_100_000,
    entryAmountX: "1000",
    entryAmountY: "2000",
    entryValueUsd: 25,
    strategyType: "Spot",
    dryRun: true,
  };
}
