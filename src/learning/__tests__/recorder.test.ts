import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { JsonlStore } from "../jsonl-store.js";
import { LearningRecorder } from "../recorder.js";
import type { LearningDecision, ScreeningResult } from "../../types/index.js";

function makeRecorder(): {
  recorder: LearningRecorder;
  store: JsonlStore<LearningDecision & Record<string, unknown>>;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-recorder-"));
  const store = new JsonlStore<LearningDecision & Record<string, unknown>>(
    path.join(tmpDir, "learning-decisions.jsonl"),
  );

  return {
    store,
    recorder: new LearningRecorder({
      decisionsStore: store,
      learningConfig: {
        enabled: true,
        mode: "active",
        horizonsMinutes: [10],
        minEvidenceForScore: 1,
        injectIntoManagerPrompt: true,
        recencyHalfLifeDays: 14,
        maxOutcomesPerCycle: 20,
        files: {
          decisions: "learning-decisions.jsonl",
          outcomes: "learning-outcomes.jsonl",
          shadowScores: "shadow-scores.jsonl",
          lessons: "learning-lessons.jsonl",
          snapshot: "learning-snapshot.jsonl",
          signalWeights: "signal-weights.json",
        },
      },
    }),
  };
}

function baseResult(): ScreeningResult {
  return {
    timestamp: 123,
    cycleId: "cycle",
    filtersPassed: true,
    filterReport: {},
    realtimeSignals: [],
    pool: {
      address: "pool",
      name: "MEME-SOL",
      tokenX: {
        mint: "meme",
        symbol: "MEME",
        decimals: 6,
        organicScore: 72,
        holders: 1234,
        marketCap: 456_000,
      },
      tokenY: {
        mint: "sol",
        symbol: "SOL",
        decimals: 9,
        organicScore: 99,
        holders: 3_800_000,
        marketCap: 48_000_000_000,
      },
      binStep: 100,
      baseFeeBps: 100,
      tvl: 20_000,
      activeTvl: 10_000,
      volume24h: 1_000,
      fees24h: 20,
      activeBinId: -10,
      currentPrice: 0.001,
    },
    decision: {
      action: "ENTER",
      confidence: 0.7,
      reasons: ["ok"],
      risks: [],
      suggestedSizeUsd: 200,
      suggestedRangeBps: 500,
    },
  };
}

describe("LearningRecorder", () => {
  it("records screener features from the speculative token, not SOL quote", () => {
    const { recorder, store } = makeRecorder();

    recorder.recordScreener(baseResult(), "cycle");
    const [decision] = store.readAll();

    assert.equal(decision?.features.organicScore, 72);
    assert.equal(decision?.features.holders, 1234);
    assert.equal(decision?.features.mcUsd, 456_000);
    assert.equal(decision?.features.entryPrice, 0.001);
    assert.equal(decision?.features.rangeBinsPerSide, 2.5);
  });

  it("records tokenY features when tokenX is the quote side", () => {
    const { recorder, store } = makeRecorder();
    const result = baseResult();
    result.pool.name = "USDC-MEME";
    result.pool.tokenX = {
      mint: "usdc",
      symbol: "USDC",
      decimals: 6,
      organicScore: 100,
      holders: 5_000_000,
      marketCap: 8_000_000_000,
    };
    result.pool.tokenY = {
      mint: "meme",
      symbol: "MEME",
      decimals: 6,
      organicScore: 65,
      holders: 900,
      marketCap: 250_000,
    };

    recorder.recordScreener(result, "cycle");
    const [decision] = store.readAll();

    assert.equal(decision?.features.organicScore, 65);
    assert.equal(decision?.features.holders, 900);
    assert.equal(decision?.features.mcUsd, 250_000);
  });
});
