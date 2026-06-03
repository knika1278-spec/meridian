import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { EvidenceIndex } from "../evidence-index.js";
import { JsonlStore } from "../jsonl-store.js";
import { ShadowRanker } from "../shadow-ranker.js";
import type {
  LearningDecision,
  LearningOutcome,
  ShadowScore,
} from "../../types/index.js";

type DecisionRow = LearningDecision & Record<string, unknown>;
type OutcomeRow = LearningOutcome & Record<string, unknown>;
type ShadowRow = ShadowScore & Record<string, unknown>;

let tmpDir: string;

function baseDecision(id: string): LearningDecision {
  return {
    id,
    kind: "screener",
    timestamp: Date.now(),
    pool: { address: `pool-${id}`, name: "ALPHA-SOL" },
    action: "ENTER",
    reasons: [],
    risks: [],
    features: {
      pairClass: "exotic",
      binStep: 100,
      feeOverActiveTvl: 0.1,
      volumeOverTvl: 1,
      riskFlags: [],
    },
  };
}

describe("ShadowRanker", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-ranker-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refreshes evidence before scoring so new outcomes appear without restart", () => {
    const decisionsStore = new JsonlStore<DecisionRow>(
      path.join(tmpDir, "decisions.jsonl"),
    );
    const outcomesStore = new JsonlStore<OutcomeRow>(
      path.join(tmpDir, "outcomes.jsonl"),
    );
    const shadowStore = new JsonlStore<ShadowRow>(
      path.join(tmpDir, "shadow.jsonl"),
    );
    const index = new EvidenceIndex({ decisionsStore, outcomesStore });
    index.build();

    decisionsStore.append(baseDecision("historical") as DecisionRow);
    outcomesStore.append({
      decisionId: "historical",
      horizonMinutes: 30,
      kind: "entry_market_proxy",
      evaluatedAt: Date.now(),
      riskFlagsTripped: [],
      netPnlRiskScore: 0.6,
    });

    const ranker = new ShadowRanker({
      index,
      shadowStore,
      minEvidence: 1,
    });
    const score = ranker.score(baseDecision("fresh"));

    assert.ok(score);
    assert.equal(score.sampleSize, 1);
    assert.equal(shadowStore.count(), 1);
  });
});
