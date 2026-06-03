import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DecisionLogger } from "../decision-logger.js";
import type { ScreeningResult } from "../../types/index.js";

let tmpDir: string;
let filePath: string;

function makeTmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `decision-logger-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeResult(): ScreeningResult {
  return {
    pool: {
      address: "pool-alpha",
      name: "ALPHA-USDC",
      tokenX: { mint: "mint-x", symbol: "ALPHA", decimals: 6 },
      tokenY: { mint: "mint-y", symbol: "USDC", decimals: 6 },
      binStep: 10,
      baseFeeBps: 20,
      tvl: 100_000,
      activeTvl: 20_000,
      volume24h: 300_000,
      fees24h: 500,
      activeBinId: 1,
      currentPrice: 1,
    },
    filtersPassed: true,
    filterReport: {},
    realtimeSignals: [],
    decision: {
      action: "WATCH",
      confidence: 0.5,
      reasons: ["watch"],
      risks: ["risk"],
    },
    timestamp: 123,
    cycleId: "cycle-1",
  };
}

describe("DecisionLogger legacy JSON log", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
    filePath = path.join(tmpDir, "decision-log.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("still writes decision-log.json as an array for legacy review tools", () => {
    const logger = new DecisionLogger(filePath);
    logger.append(makeResult(), true);

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    assert.ok(Array.isArray(parsed));
    const entries = logger.readAll();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]?.pool.name, "ALPHA-USDC");
    assert.strictEqual(entries[0]?.decision?.action, "WATCH");
    assert.strictEqual(entries[0]?.dryRun, true);
  });
});
