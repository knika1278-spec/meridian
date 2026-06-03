// Unit tests for EvidenceIndex + bucketKeyFor banding.
// Uses node:test runner via tsx --test.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { JsonlStore } from "../jsonl-store.js";
import {
  EvidenceIndex,
  bucketKeyFor,
  bucketKeyString,
} from "../evidence-index.js";
import type {
  LearningDecision,
  LearningDecisionFeatures,
  LearningOutcome,
} from "../../types/index.js";

type DecisionRow = LearningDecision & Record<string, unknown>;
type OutcomeRow = LearningOutcome & Record<string, unknown>;

const BASE_FEATURES: LearningDecisionFeatures = {
  pairClass: "exotic",
  binStep: 50,
  feeOverActiveTvl: 0.1,
  volumeOverTvl: 1.0,
  riskFlags: [],
};

let tmpDir: string;
let decisionsPath: string;
let outcomesPath: string;

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

function buildIndex(opts?: { recencyHalfLifeDays?: number }): EvidenceIndex {
  const decisionsStore = new JsonlStore<DecisionRow>(decisionsPath);
  const outcomesStore = new JsonlStore<OutcomeRow>(outcomesPath);
  return new EvidenceIndex({
    decisionsStore,
    outcomesStore,
    recencyHalfLifeDays: opts?.recencyHalfLifeDays,
  });
}

describe("bucketKeyFor banding", () => {
  it("bins binStep into low/mid/high", () => {
    assert.strictEqual(bucketKeyFor({ binStep: 30 }).binStepBand, "low");
    assert.strictEqual(bucketKeyFor({ binStep: 100 }).binStepBand, "mid");
    assert.strictEqual(bucketKeyFor({ binStep: 200 }).binStepBand, "high");
  });

  it("bins feeOverActiveTvl into bands", () => {
    assert.strictEqual(
      bucketKeyFor({ feeOverActiveTvl: 0.01 }).feeTvlBand,
      "lt_0_05",
    );
    assert.strictEqual(
      bucketKeyFor({ feeOverActiveTvl: 0.1 }).feeTvlBand,
      "0_05_to_0_2",
    );
    assert.strictEqual(
      bucketKeyFor({ feeOverActiveTvl: 0.3 }).feeTvlBand,
      "gt_0_2",
    );
  });

  it("bins volumeOverTvl into bands", () => {
    assert.strictEqual(
      bucketKeyFor({ volumeOverTvl: 0.1 }).volTvlBand,
      "lt_0_5",
    );
    assert.strictEqual(
      bucketKeyFor({ volumeOverTvl: 1.0 }).volTvlBand,
      "0_5_to_2",
    );
    assert.strictEqual(bucketKeyFor({ volumeOverTvl: 5.0 }).volTvlBand, "gt_2");
  });

  it("defaults pairClass to unknown and rfCount to 0", () => {
    const key = bucketKeyFor({});
    assert.strictEqual(key.pairClass, "unknown");
    assert.strictEqual(key.riskFlagsCount, 0);
  });

  it("caps riskFlagsCount at 2", () => {
    assert.strictEqual(
      bucketKeyFor({ riskFlags: ["a", "b", "c"] }).riskFlagsCount,
      2,
    );
  });
});

describe("EvidenceIndex query", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-t20-evidence-"));
    decisionsPath = path.join(tmpDir, "decisions.jsonl");
    outcomesPath = path.join(tmpDir, "outcomes.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns zero sample on empty index", () => {
    fs.writeFileSync(decisionsPath, "", "utf-8");
    fs.writeFileSync(outcomesPath, "", "utf-8");
    const idx = buildIndex();
    idx.build();
    const q = idx.query(BASE_FEATURES);
    assert.strictEqual(q.sampleSize, 0);
    assert.strictEqual(q.avgScore, 0);
  });

  it("aggregates 7 pos / 3 neg in same bucket", () => {
    const now = Date.now();
    const decisions = Array.from({ length: 10 }, (_, i) => ({
      id: `d_${i}`,
      timestamp: now,
      features: BASE_FEATURES,
    }));
    const outcomes = Array.from({ length: 10 }, (_, i) => ({
      decisionId: `d_${i}`,
      horizonMinutes: 30,
      evaluatedAt: now,
      netPnlRiskScore: i < 7 ? 0.5 : -0.5,
    }));
    seedDecisions(decisionsPath, decisions);
    seedOutcomes(outcomesPath, outcomes);

    const idx = buildIndex();
    idx.build();
    const q = idx.query(BASE_FEATURES);

    assert.strictEqual(q.sampleSize, 10);
    assert.ok(
      q.avgScore > 0.15 && q.avgScore < 0.25,
      `avgScore ${q.avgScore} not within (0.15, 0.25)`,
    );
    assert.strictEqual(q.pos, 7);
    assert.strictEqual(q.neg, 3);
  });

  it("recency decay shifts avg toward newer outcomes", () => {
    const now = Date.now();
    seedDecisions(decisionsPath, [
      { id: "d_recent", timestamp: now, features: BASE_FEATURES },
      { id: "d_old", timestamp: now, features: BASE_FEATURES },
    ]);
    seedOutcomes(outcomesPath, [
      {
        decisionId: "d_recent",
        horizonMinutes: 30,
        evaluatedAt: now,
        netPnlRiskScore: 1,
      },
      {
        decisionId: "d_old",
        horizonMinutes: 30,
        evaluatedAt: now - 30 * 86_400_000,
        netPnlRiskScore: -1,
      },
    ]);

    const idx = buildIndex({ recencyHalfLifeDays: 14 });
    idx.build();
    const q = idx.query(BASE_FEATURES);

    assert.strictEqual(q.sampleSize, 2);
    assert.ok(
      q.avgScore > 0.5,
      `expected avgScore > 0.5 (recency bias), got ${q.avgScore}`,
    );
  });

  it("allBuckets returns non-empty buckets after seeding", () => {
    const now = Date.now();
    const decisions = Array.from({ length: 6 }, (_, i) => ({
      id: `d_${i}`,
      timestamp: now,
      features: BASE_FEATURES,
    }));
    const outcomes = Array.from({ length: 6 }, (_, i) => ({
      decisionId: `d_${i}`,
      horizonMinutes: 30,
      evaluatedAt: now,
      netPnlRiskScore: 0.5,
    }));
    seedDecisions(decisionsPath, decisions);
    seedOutcomes(outcomesPath, outcomes);

    const idx = buildIndex();
    idx.build();
    const buckets = idx.allBuckets();
    assert.ok(buckets.length >= 1, "expected at least one bucket");
    for (const b of buckets) {
      assert.ok(b.sampleSize > 0, "every bucket should have samples");
      assert.ok(b.bucketKey.length > 0, "bucketKey should not be empty");
    }
    // Sanity: the bucketKey matches base features.
    const expected = bucketKeyString(bucketKeyFor(BASE_FEATURES));
    assert.ok(
      buckets.some((b) => b.bucketKey === expected),
      `expected bucket ${expected} to exist`,
    );
  });
});
