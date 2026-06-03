// Shadow ranker for the learning loop (v1: observation only).
// For each new screener decision, queries the EvidenceIndex and emits a
// ShadowScore plus an optional ShadowDisagreement. Never vetoes, never
// mutates — append-only to the shadow store.

import type {
  LearningDecision,
  ShadowScore,
  ShadowDisagreement,
} from "../types/index.js";
import type { JsonlStore } from "./jsonl-store.js";
import type { EvidenceIndex } from "./evidence-index.js";
import { childLogger } from "../utils/logger.js";

export interface ShadowRankerOptions {
  index: EvidenceIndex;
  shadowStore: JsonlStore<ShadowScore & Record<string, unknown>>;
  minEvidence: number;
  /** ENTER-disagreement threshold (default -0.1). */
  enterThreshold?: number;
  /** SKIP-disagreement threshold (default 0.2). */
  skipThreshold?: number;
}

const log = childLogger("shadow-ranker");

export class ShadowRanker {
  private readonly index: EvidenceIndex;
  private readonly shadowStore: JsonlStore<
    ShadowScore & Record<string, unknown>
  >;
  private readonly minEvidence: number;
  private readonly enterThreshold: number;
  private readonly skipThreshold: number;

  constructor(opts: ShadowRankerOptions) {
    this.index = opts.index;
    this.shadowStore = opts.shadowStore;
    this.minEvidence = opts.minEvidence;
    this.enterThreshold = opts.enterThreshold ?? -0.1;
    this.skipThreshold = opts.skipThreshold ?? 0.2;
  }

  /** Returns the score and ALSO appends it to the store. Returns null when sampleSize < minEvidence. */
  score(decision: LearningDecision): ShadowScore | null {
    this.index.build();
    const query = this.index.query(decision.features);

    if (query.sampleSize < this.minEvidence) {
      return null;
    }

    const expectedScore = query.avgScore;
    const sampleSize = query.sampleSize;
    const riskScore = sampleSize > 0 ? query.neg / sampleSize : 0;
    const confidence = Math.min(
      1,
      sampleSize / Math.max(this.minEvidence * 3, 1),
    );
    const topEvidence = query.topEvidence;

    let disagreement: ShadowDisagreement | undefined;
    if (decision.action === "ENTER" && expectedScore < this.enterThreshold) {
      disagreement = {
        llmAction: "ENTER",
        shadowRecommendation: "avoid",
        magnitude: Math.abs(expectedScore),
      };
    } else if (decision.action === "SKIP" && expectedScore > this.skipThreshold) {
      disagreement = {
        llmAction: "SKIP",
        shadowRecommendation: "favor",
        magnitude: expectedScore,
      };
    }

    const score: ShadowScore = {
      decisionId: decision.id,
      generatedAt: Date.now(),
      bucketKey: query.bucketKey,
      expectedScore,
      riskScore,
      sampleSize,
      confidence,
      topEvidence,
      disagreement,
    };

    try {
      this.shadowStore.append(score as ShadowScore & Record<string, unknown>);
    } catch (err) {
      log.warn({ err, decisionId: decision.id }, "shadow store append failed");
    }

    return score;
  }
}
