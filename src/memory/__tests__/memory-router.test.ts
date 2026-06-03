import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { JsonlStore } from "../../learning/jsonl-store.js";
import { DecisionJournal } from "../decision-journal.js";
import { MemoryRouter } from "../memory-router.js";
import type {
  LearningDecision,
  LearningLesson,
  Lesson,
  Position,
  ScreeningResult,
  ShadowScore,
  UserConfig,
} from "../../types/index.js";

type LearningDecisionRow = LearningDecision & Record<string, unknown>;
type LearningLessonRow = LearningLesson & Record<string, unknown>;
type ShadowScoreRow = ShadowScore & Record<string, unknown>;

let tmpDir: string;
let journalPath: string;
let lessonsPath: string;
let learningDecisionsPath: string;
let learningLessonsPath: string;
let shadowPath: string;

function makeTmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `memory-router-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(maxPromptItems = 3): UserConfig {
  return {
    manager: { lessonsFile: lessonsPath },
    learning: {
      files: {
        decisions: learningDecisionsPath,
        outcomes: path.join(tmpDir, "outcomes.jsonl"),
        shadowScores: shadowPath,
        lessons: learningLessonsPath,
        snapshot: path.join(tmpDir, "snapshot.jsonl"),
        signalWeights: path.join(tmpDir, "signal-weights.json"),
      },
    },
    memory: {
      enabled: true,
      journalFile: journalPath,
      injectIntoScreener: true,
      injectIntoManager: true,
      injectIntoPostMortem: true,
      recentLimit: 8,
      maxPromptItems,
      includeLearningEvidence: true,
      minEvidenceForPrompt: 5,
    },
  } as UserConfig;
}

function makeRouter(config = makeConfig()): MemoryRouter {
  return new MemoryRouter({
    config,
    journal: new DecisionJournal(journalPath),
    learningDecisionStore: new JsonlStore<LearningDecisionRow>(
      learningDecisionsPath,
    ),
    learningLessonsStore: new JsonlStore<LearningLessonRow>(
      learningLessonsPath,
    ),
    shadowStore: new JsonlStore<ShadowScoreRow>(shadowPath),
  });
}

function makeScreeningResult(poolName = "ALPHA-USDC"): ScreeningResult {
  const [x = "ALPHA", y = "USDC"] = poolName.split("-");
  return {
    pool: {
      address: `pool-${poolName}`,
      name: poolName,
      tokenX: { mint: "mint-x", symbol: x, decimals: 6 },
      tokenY: { mint: "mint-y", symbol: y, decimals: 6 },
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
    timestamp: Date.now(),
    cycleId: "cycle-1",
  };
}

function makePosition(): Position {
  return {
    positionPubkey: "pos-alpha",
    poolAddress: "pool-ALPHA-USDC",
    poolName: "ALPHA-USDC",
    tokenX: { mint: "mint-x", symbol: "ALPHA", decimals: 6 },
    tokenY: { mint: "mint-y", symbol: "USDC", decimals: 6 },
    binStep: 10,
    lowerBinId: 0,
    upperBinId: 10,
    entryActiveBinId: 5,
    entryPrice: 1,
    entryTimestamp: Date.now() - 60_000,
    entryAmountX: "0",
    entryAmountY: "0",
    entryValueUsd: 100,
    strategyType: "Spot",
    dryRun: true,
  };
}

function writeLessons(lessons: Lesson[]): void {
  fs.writeFileSync(lessonsPath, JSON.stringify(lessons, null, 2), "utf-8");
}

describe("MemoryRouter", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
    journalPath = path.join(tmpDir, "decision-journal.jsonl");
    lessonsPath = path.join(tmpDir, "lessons.json");
    learningDecisionsPath = path.join(tmpDir, "learning-decisions.jsonl");
    learningLessonsPath = path.join(tmpDir, "learning-lessons.jsonl");
    shadowPath = path.join(tmpDir, "shadow-scores.jsonl");
    writeLessons([]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("routes same-pool journal entries into screener memory", () => {
    const journal = new DecisionJournal(journalPath);
    journal.append({
      timestamp: Date.now() - 1_000,
      actor: "EXECUTOR",
      event: "NO_DEPLOY",
      subject: {
        poolAddress: "pool-ALPHA-USDC",
        poolName: "ALPHA-USDC",
        tokenSymbols: ["ALPHA", "USDC"],
      },
      action: "OPEN",
      status: "SKIPPED",
      summary: "No deploy: dryRun enabled",
      reasons: ["dryRun enabled"],
      risks: [],
      metrics: {},
      rejectedAlternatives: ["OPEN_POSITION"],
      linkedIds: {},
      dryRun: true,
    });
    journal.append({
      timestamp: Date.now(),
      actor: "SCREENER",
      event: "SCREEN_DECISION",
      subject: {
        poolAddress: "pool-BETA-SOL",
        poolName: "BETA-SOL",
        tokenSymbols: ["BETA", "SOL"],
      },
      action: "ENTER",
      status: "PROPOSED",
      summary: "unrelated",
      reasons: [],
      risks: [],
      metrics: {},
      rejectedAlternatives: [],
      linkedIds: {},
      dryRun: true,
    });

    const bundle = makeRouter().forScreener(makeScreeningResult());
    assert.strictEqual(bundle.recentDecisions.length, 1);
    assert.match(bundle.recentDecisions[0]?.summary ?? "", /dryRun/);
  });

  it("prioritizes same-position manager memory over merely same-pool memory", () => {
    const journal = new DecisionJournal(journalPath);
    journal.append({
      timestamp: Date.now(),
      actor: "MANAGER",
      event: "MANAGER_DECISION",
      subject: {
        poolAddress: "pool-ALPHA-USDC",
        poolName: "ALPHA-USDC",
        tokenSymbols: ["ALPHA", "USDC"],
      },
      action: "HOLD",
      status: "PROPOSED",
      summary: "same pool only",
      reasons: [],
      risks: [],
      metrics: {},
      rejectedAlternatives: [],
      linkedIds: {},
      dryRun: true,
    });
    journal.append({
      timestamp: Date.now() - 30 * 86_400_000,
      actor: "MANAGER",
      event: "ACTION_SUCCESS",
      subject: {
        poolAddress: "pool-ALPHA-USDC",
        poolName: "ALPHA-USDC",
        positionPubkey: "pos-alpha",
        tokenSymbols: ["ALPHA", "USDC"],
      },
      action: "CLOSE",
      status: "SUCCESS",
      summary: "same position close history",
      reasons: [],
      risks: [],
      metrics: {},
      rejectedAlternatives: [],
      linkedIds: {},
      dryRun: true,
    });

    const bundle = makeRouter().forManager(makePosition());
    assert.match(
      bundle.recentDecisions[0]?.summary ?? "",
      /same position close history/,
    );
  });

  it("injects relevant lessons and trims to maxPromptItems", () => {
    writeLessons([
      {
        id: "L-alpha",
        timestamp: Date.now(),
        poolName: "ALPHA-USDC",
        tags: ["ALPHA", "USDC"],
        ruleForFuture: "Avoid ALPHA when active bin drifts.",
        context: { entry: "entry", exit: "exit", pnlUsd: -5 },
      },
      {
        id: "L-alpha-2",
        timestamp: Date.now() - 1,
        poolName: "ALPHA-USDC",
        tags: ["ALPHA"],
        ruleForFuture: "Favor ALPHA only after fresh fees.",
        context: { entry: "entry", exit: "exit", pnlUsd: 5 },
      },
      {
        id: "L-beta",
        timestamp: Date.now(),
        poolName: "BETA-SOL",
        tags: ["BETA", "SOL"],
        ruleForFuture: "Unrelated.",
        context: { entry: "", exit: "", pnlUsd: 0 },
      },
    ]);

    const bundle = makeRouter(makeConfig(1)).forScreener(makeScreeningResult());
    assert.strictEqual(bundle.lessons.length, 1);
    assert.match(bundle.lessons[0]?.id ?? "", /^L-alpha/);
  });

  it("routes closed-position learning lessons as lesson memory with sample size 1", () => {
    const learningLessons = new JsonlStore<LearningLessonRow>(
      learningLessonsPath,
    );
    learningLessons.append({
      id: "LL-closed",
      timestamp: Date.now(),
      poolName: "ALPHA-USDC",
      tags: ["ALPHA", "USDC"],
      positiveTakeaway: null,
      mistake: "closed loss",
      ruleForFuture: "Avoid ALPHA after fast active-bin drift.",
      context: { entry: "entry", exit: "exit", pnlUsd: -4 },
      source: "closed_position",
      evidence: {
        lessonId: "LL-closed",
        sampleSize: 1,
        avgOutcome: -0.4,
        bestExamples: [],
        worstExamples: ["closed loss"],
        applicability: { tags: ["ALPHA", "USDC"], poolName: "ALPHA-USDC" },
      },
    });

    const bundle = makeRouter().forScreener(makeScreeningResult());
    assert.ok(bundle.lessons.some((item) => item.id === "LL-closed"));
    assert.ok(!bundle.learningEvidence.some((item) => item.id === "LL-closed"));
  });

  it("injects learning evidence only when sample size meets the prompt floor", () => {
    const decisionStore = new JsonlStore<LearningDecisionRow>(
      learningDecisionsPath,
    );
    decisionStore.append({
      id: "ld-1",
      kind: "screener",
      timestamp: Date.now(),
      pool: { address: "pool-ALPHA-USDC", name: "ALPHA-USDC" },
      action: "ENTER",
      reasons: [],
      risks: [],
      features: {},
    });

    const learningLessons = new JsonlStore<LearningLessonRow>(
      learningLessonsPath,
    );
    learningLessons.append({
      id: "LL-good",
      timestamp: Date.now(),
      poolName: "ALPHA-USDC",
      tags: ["ALPHA", "USDC"],
      positiveTakeaway: "good",
      mistake: null,
      ruleForFuture: "Favor this cohort.",
      context: { entry: "", exit: "", pnlUsd: 1 },
      source: "cohort",
      evidence: {
        lessonId: "LL-good",
        sampleSize: 5,
        avgOutcome: 0.9,
        bestExamples: [],
        worstExamples: [],
        applicability: { tags: ["ALPHA", "USDC"], poolName: "ALPHA-USDC" },
      },
    });
    // AUDIT FIX [C2-MITIGATED]: toxic cohort (favorable sample size, negative
    // avgOutcome) must NOT be injected — normalized 0.2 is below the 0.7 floor.
    learningLessons.append({
      id: "LL-toxic",
      timestamp: Date.now(),
      poolName: "ALPHA-USDC",
      tags: ["ALPHA", "USDC"],
      positiveTakeaway: null,
      mistake: "rug",
      ruleForFuture: "Avoid this cohort.",
      context: { entry: "", exit: "", pnlUsd: -1 },
      source: "cohort",
      evidence: {
        lessonId: "LL-toxic",
        sampleSize: 5,
        avgOutcome: -0.6,
        bestExamples: [],
        worstExamples: [],
        applicability: { tags: ["ALPHA", "USDC"], poolName: "ALPHA-USDC" },
      },
    });
    learningLessons.append({
      id: "LL-small",
      timestamp: Date.now(),
      poolName: "ALPHA-USDC",
      tags: ["ALPHA", "USDC"],
      positiveTakeaway: "too small",
      mistake: null,
      ruleForFuture: "Do not inject yet.",
      context: { entry: "", exit: "", pnlUsd: 1 },
      source: "cohort",
      evidence: {
        lessonId: "LL-small",
        sampleSize: 4,
        avgOutcome: 0.9,
        bestExamples: [],
        worstExamples: [],
        applicability: { tags: ["ALPHA", "USDC"], poolName: "ALPHA-USDC" },
      },
    });

    const shadowStore = new JsonlStore<ShadowScoreRow>(shadowPath);
    shadowStore.append({
      decisionId: "ld-1",
      generatedAt: Date.now(),
      bucketKey: "ALPHA|USDC",
      expectedScore: -0.3,
      riskScore: 0.5,
      sampleSize: 5,
      confidence: 0.8,
      topEvidence: [{ decisionId: "old", score: -1, summary: "bad cohort" }],
      disagreement: {
        llmAction: "ENTER",
        shadowRecommendation: "avoid",
        magnitude: 0.3,
      },
    });

    const bundle = makeRouter().forScreener(makeScreeningResult());
    const ids = bundle.learningEvidence.map((item) => item.id);
    assert.ok(ids.includes("LL-good"));
    assert.ok(ids.includes("shadow:ld-1"));
    assert.ok(!ids.includes("LL-small"));
    assert.ok(!ids.includes("LL-toxic"));
  });
});
