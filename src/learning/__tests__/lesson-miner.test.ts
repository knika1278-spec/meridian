// Unit tests for LessonMiner.
// Uses node:test runner via tsx --test.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { JsonlStore } from "../jsonl-store.js";
import { EvidenceIndex } from "../evidence-index.js";
import { LessonMiner } from "../lesson-miner.js";
import { LessonStore } from "../../agents/lesson-store.js";
import { ClosedPositionStore } from "../../agents/closed-position-store.js";
import type {
  ClosedPosition,
  LearningDecision,
  LearningLesson,
  LearningOutcome,
  Position,
  PositionEvaluation,
} from "../../types/index.js";

type DecisionRow = LearningDecision & Record<string, unknown>;
type OutcomeRow = LearningOutcome & Record<string, unknown>;
type LessonRow = LearningLesson & Record<string, unknown>;

let tmpDir: string;
let decisionsPath: string;
let outcomesPath: string;
let lessonsPath: string;
let evidenceLessonsPath: string;
let closedPath: string;

function seedDecisions(
  filePath: string,
  decisions: Array<Partial<LearningDecision>>,
): void {
  const lines = decisions.map((d, i) =>
    JSON.stringify({
      id: d.id ?? `d_${i}`,
      kind: d.kind ?? "screener",
      timestamp: d.timestamp ?? Date.now() - 24 * 60 * 60 * 1000,
      pool: d.pool ?? { address: `pool${i}`, name: `T${i}-USDC` },
      action: d.action ?? "ENTER",
      reasons: d.reasons ?? [],
      risks: d.risks ?? [],
      features: d.features ?? {},
      ...d,
    }),
  );
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

function seedOutcomes(
  filePath: string,
  outcomes: Array<Partial<LearningOutcome>>,
): void {
  const lines = outcomes.map((o, i) =>
    JSON.stringify({
      decisionId: o.decisionId ?? `d_${i}`,
      horizonMinutes: o.horizonMinutes ?? 30,
      kind: o.kind ?? "entry_market_proxy",
      evaluatedAt: o.evaluatedAt ?? Date.now(),
      riskFlagsTripped: o.riskFlagsTripped ?? [],
      netPnlRiskScore: o.netPnlRiskScore ?? 0,
      ...o,
    }),
  );
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

function makeClosedPosition(): ClosedPosition {
  const position: Position = {
    positionPubkey: "pos1",
    poolAddress: "pool1",
    poolName: "TEST-USDC",
    tokenX: {
      symbol: "TEST",
      mint: "mintX",
      decimals: 6,
    } as Position["tokenX"],
    tokenY: {
      symbol: "USDC",
      mint: "mintY",
      decimals: 6,
    } as Position["tokenY"],
    binStep: 50,
    lowerBinId: 0,
    upperBinId: 100,
    entryActiveBinId: 50,
    entryPrice: 1,
    entryTimestamp: Date.now() - 100 * 60_000,
    entryAmountX: "0",
    entryAmountY: "0",
    entryValueUsd: 100,
    strategyType: "Spot",
    dryRun: true,
  };
  const finalEvaluation: PositionEvaluation = {
    position,
    evaluatedAt: Date.now(),
    currentActiveBinId: 50,
    inRange: false,
    inRangePct: 0,
    outOfRangeMinutes: 100,
    currentPrice: 1,
    currentAmountX: "0",
    currentAmountY: "0",
    currentValueUsd: 90,
    claimableFees: { tokenX: "0", tokenY: "0", usdValue: 0 },
    pnlUsd: -10,
    pnlPct: -0.1,
    ilUsd: 0,
    ageMinutes: 100,
  };
  return {
    position,
    closedAt: Date.now(),
    exitReason: "out_of_range",
    exitValueUsd: 90,
    totalFeesUsdEarned: 0,
    realizedPnlUsd: -10,
    realizedPnlPct: -0.1,
    realizedIlUsd: 0,
    ageMinutes: 100,
    finalEvaluation,
  };
}

function buildMiner(): {
  miner: LessonMiner;
  lessonStore: LessonStore;
  evidenceLessonsStore: JsonlStore<LessonRow>;
  closedStore: ClosedPositionStore;
} {
  const decisionsStore = new JsonlStore<DecisionRow>(decisionsPath);
  const outcomesStore = new JsonlStore<OutcomeRow>(outcomesPath);
  const index = new EvidenceIndex({ decisionsStore, outcomesStore });
  index.build();

  const lessonStore = new LessonStore({ filePath: lessonsPath });
  const evidenceLessonsStore = new JsonlStore<LessonRow>(evidenceLessonsPath);
  const closedStore = new ClosedPositionStore({ filePath: closedPath });

  const miner = new LessonMiner({
    lessonStore,
    evidenceLessonsStore,
    index,
    closedStore,
    minCohortSamples: 3,
    minCohortAbsAvg: 0.1,
  });
  return { miner, lessonStore, evidenceLessonsStore, closedStore };
}

describe("LessonMiner", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-t20-miner-"));
    decisionsPath = path.join(tmpDir, "decisions.jsonl");
    outcomesPath = path.join(tmpDir, "outcomes.jsonl");
    lessonsPath = path.join(tmpDir, "lessons.json");
    evidenceLessonsPath = path.join(tmpDir, "learning-lessons.jsonl");
    closedPath = path.join(tmpDir, "closed-positions.json");

    fs.writeFileSync(lessonsPath, "[]", "utf-8");
    fs.writeFileSync(closedPath, "[]", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is idempotent across consecutive mines", async () => {
    const now = Date.now();
    const features = {
      pairClass: "exotic" as const,
      binStep: 50,
      feeOverActiveTvl: 0.1,
      volumeOverTvl: 1.0,
      riskFlags: [],
    };
    const decisions = Array.from({ length: 6 }, (_, i) => ({
      id: `d_${i}`,
      timestamp: now,
      features,
    }));
    const outcomes = Array.from({ length: 6 }, (_, i) => ({
      decisionId: `d_${i}`,
      horizonMinutes: 30,
      evaluatedAt: now,
      netPnlRiskScore: 0.5,
    }));
    seedDecisions(decisionsPath, decisions);
    seedOutcomes(outcomesPath, outcomes);

    // Build first miner, seed closed position, mine.
    const setup1 = buildMiner();
    setup1.closedStore.add(makeClosedPosition());

    const r1 = await setup1.miner.mine();
    assert.ok(r1.added > 0, `expected r1.added > 0, got ${r1.added}`);

    // Build a fresh miner instance over the SAME files (so it re-reads
    // existing evidence-lessons + lessons from disk).
    const setup2 = buildMiner();
    const r2 = await setup2.miner.mine();
    assert.strictEqual(r2.added, 0, `expected r2.added === 0, got ${r2.added}`);
    assert.ok(
      r2.deduped >= r1.added,
      `expected r2.deduped >= r1.added (${r1.added}), got ${r2.deduped}`,
    );
  });

  it("adds a closed-position lesson with source closed_position", async () => {
    const { miner, evidenceLessonsStore, closedStore } = buildMiner();
    closedStore.add(makeClosedPosition());

    const result = await miner.mine();
    assert.ok(
      result.added >= 1,
      `expected at least 1 lesson added, got ${result.added}`,
    );

    const all = evidenceLessonsStore.readAll();
    const closedLessons = all.filter((l) => l.source === "closed_position");
    assert.ok(
      closedLessons.length >= 1,
      `expected a closed_position lesson; got ${closedLessons.length}`,
    );
    const lesson = closedLessons[0];
    assert.ok(lesson);
    assert.strictEqual(lesson.poolName, "TEST-USDC");
    assert.ok(
      lesson.ruleForFuture.includes("TEST-USDC"),
      `rule should reference pool name: ${lesson.ruleForFuture}`,
    );
    assert.ok(
      lesson.ruleForFuture.includes("out_of_range"),
      `rule should reference exitReason: ${lesson.ruleForFuture}`,
    );
  });

  it("dedupes against pre-seeded LessonStore entry by normalized rule", async () => {
    const { miner, lessonStore, evidenceLessonsStore, closedStore } =
      buildMiner();
    closedStore.add(makeClosedPosition());

    // Pre-seed the lessonStore with the EXACT rule the miner will produce.
    // Template (from lesson-miner.ts buildClosedCandidate):
    //   `${direction}: ${poolName} closed at ${exitReason} (pnl=${pnl.toFixed(2)}, score=${score.toFixed(2)} after ${age}m)`
    const preExistingRule =
      "avoid: TEST-USDC closed at out_of_range (pnl=-10.00, score=-0.20 after 100m)";
    lessonStore.add({
      id: "PRE-1",
      timestamp: Date.now(),
      poolName: "TEST-USDC",
      tags: ["closed", "avoid"],
      positiveTakeaway: null,
      mistake: "test",
      ruleForFuture: preExistingRule,
      context: { entry: "", exit: "", pnlUsd: -10 },
    });

    const result = await miner.mine();
    const all = evidenceLessonsStore.readAll();
    const closedLessons = all.filter((l) => l.source === "closed_position");
    assert.strictEqual(
      closedLessons.length,
      0,
      `expected closed_position lesson to be deduped; got ${closedLessons.length}`,
    );
    assert.ok(
      result.deduped >= 1,
      `expected result.deduped >= 1, got ${result.deduped}`,
    );
  });

  it("treats legacy positive PnL with negative IL as avoid", async () => {
    const { miner, evidenceLessonsStore, closedStore } = buildMiner();
    const closed = makeClosedPosition();
    closed.position.poolName = "BUFFDON-SOL";
    closed.position.entryValueUsd = 40;
    closed.realizedPnlUsd = 1;
    closed.realizedPnlPct = 0.025;
    closed.realizedIlUsd = -37;
    closed.totalFeesUsdEarned = 0;
    closed.finalEvaluation.outOfRangeMinutes = 9;
    closedStore.add(closed);

    await miner.mine();

    const lesson = evidenceLessonsStore
      .readAll()
      .find((item) => item.source === "closed_position");
    assert.ok(lesson);
    assert.equal(lesson.poolName, "BUFFDON-SOL");
    assert.match(lesson.ruleForFuture, /^avoid:/);
    assert.ok(lesson.evidence.avgOutcome < 0);
  });
});
