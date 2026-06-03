// Unit tests for OutcomeScheduler.
// Uses node:test runner via tsx --test.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { JsonlStore } from "../jsonl-store.js";
import { OutcomeScheduler } from "../outcome-scheduler.js";
import type { LearningDecision, LearningOutcome } from "../../types/index.js";

type DecisionRow = LearningDecision & Record<string, unknown>;
type OutcomeRow = LearningOutcome & Record<string, unknown>;

const HORIZONS = [10, 30, 120, 360];
const MIN = 60_000;

function makeTmpDir(): string {
  const base = path.join(
    os.tmpdir(),
    `outcome-scheduler-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  );
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function cleanupTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeDecision(
  id: string,
  timestamp: number,
  kind: "screener" | "manager" = "screener",
): LearningDecision {
  return {
    id,
    kind,
    timestamp,
    pool: { address: "X", name: "X-Y" },
    action: "WATCH",
    reasons: [],
    risks: [],
    features: {},
  } as unknown as LearningDecision;
}

describe("OutcomeScheduler", () => {
  let tmpDir: string;
  let decisionsPath: string;
  let outcomesPath: string;
  let decisionsStore: JsonlStore<DecisionRow>;
  let outcomesStore: JsonlStore<OutcomeRow>;
  let scheduler: OutcomeScheduler;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    decisionsPath = path.join(tmpDir, "decisions.jsonl");
    outcomesPath = path.join(tmpDir, "outcomes.jsonl");
    decisionsStore = new JsonlStore<DecisionRow>(decisionsPath);
    outcomesStore = new JsonlStore<OutcomeRow>(outcomesPath);
    scheduler = new OutcomeScheduler({
      decisionsStore,
      outcomesStore,
      horizons: HORIZONS,
    });
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it("no decisions → findDue returns []", () => {
    const result = scheduler.findDue(1_000_000);
    assert.deepStrictEqual(result, []);
  });

  it("decision at t=0, now=9 min → returns [] (no horizon due)", () => {
    decisionsStore.append(makeDecision("d1", 0) as DecisionRow);
    const now = 9 * MIN;
    const result = scheduler.findDue(now);
    assert.strictEqual(result.length, 0);
  });

  it("decision at t=0, now=11 min → returns 1 entry with horizon=10", () => {
    decisionsStore.append(makeDecision("d1", 0) as DecisionRow);
    const now = 11 * MIN;
    const result = scheduler.findDue(now);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.horizonMinutes, 10);
    assert.strictEqual(result[0]?.decision.id, "d1");
  });

  it("decision at t=0, now=400 min → returns 4 entries (all horizons)", () => {
    decisionsStore.append(makeDecision("d1", 0) as DecisionRow);
    const now = 400 * MIN;
    const result = scheduler.findDue(now);
    assert.strictEqual(result.length, 4);
    const horizons = result.map((r) => r.horizonMinutes).sort((a, b) => a - b);
    assert.deepStrictEqual(horizons, [10, 30, 120, 360]);
  });

  it("already-labeled 10-min outcome → only 30/120/360 remain due", () => {
    decisionsStore.append(makeDecision("d1", 0) as DecisionRow);
    outcomesStore.append({
      decisionId: "d1",
      horizonMinutes: 10,
      kind: "entry_market_proxy",
      evaluatedAt: 11 * MIN,
      riskFlagsTripped: [],
    } as unknown as OutcomeRow);

    const now = 400 * MIN;
    const result = scheduler.findDue(now);
    assert.strictEqual(result.length, 3);
    const horizons = result.map((r) => r.horizonMinutes).sort((a, b) => a - b);
    assert.deepStrictEqual(horizons, [30, 120, 360]);
  });

  it("mixed kinds (screener + manager), both old enough → 8 entries total", () => {
    decisionsStore.append(makeDecision("d1", 0, "screener") as DecisionRow);
    decisionsStore.append(makeDecision("d2", 0, "manager") as DecisionRow);

    const now = 400 * MIN;
    const result = scheduler.findDue(now);
    assert.strictEqual(result.length, 8);

    const byDecision = new Map<string, number[]>();
    for (const row of result) {
      const arr = byDecision.get(row.decision.id) ?? [];
      arr.push(row.horizonMinutes);
      byDecision.set(row.decision.id, arr);
    }
    assert.strictEqual(byDecision.size, 2);
    for (const [, horizons] of byDecision) {
      assert.deepStrictEqual(
        horizons.slice().sort((a, b) => a - b),
        [10, 30, 120, 360],
      );
    }
  });
});
