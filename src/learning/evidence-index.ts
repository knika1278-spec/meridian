// Cohort evidence index for the learning loop.
// Buckets (decision, outcome) pairs by feature bands so a NEW decision can
// look up "how did similar past decisions perform?". Pure data wrangling —
// no IO, no logging; stores own that.

import type {
  LearningDecision,
  LearningDecisionFeatures,
  LearningOutcome,
  PairClass,
} from "../types/index.js";
import type { JsonlStore } from "./jsonl-store.js";

export interface BucketKey {
  pairClass: PairClass;
  binStepBand: "low" | "mid" | "high";
  feeTvlBand: "lt_0_05" | "0_05_to_0_2" | "gt_0_2";
  volTvlBand: "lt_0_5" | "0_5_to_2" | "gt_2";
  riskFlagsCount: 0 | 1 | 2;
}

export interface EvidenceQuery {
  bucketKey: string;
  sampleSize: number;
  avgScore: number;
  pos: number;
  neg: number;
  topEvidence: Array<{ decisionId: string; score: number; summary: string }>;
}

type LearningDecisionRecord = LearningDecision & Record<string, unknown>;
type LearningOutcomeRecord = LearningOutcome & Record<string, unknown>;

export interface EvidenceIndexOptions {
  decisionsStore: JsonlStore<LearningDecisionRecord>;
  outcomesStore: JsonlStore<LearningOutcomeRecord>;
  recencyHalfLifeDays?: number;
  horizonWeights?: Record<number, number>;
}

interface BucketEntry {
  decisionId: string;
  score: number;
  weight: number;
  summary: string;
}

function binStepBand(binStep: number | undefined): BucketKey["binStepBand"] {
  if (binStep === undefined) return "low";
  if (binStep < 50) return "low";
  if (binStep <= 125) return "mid";
  return "high";
}

function feeTvlBand(ratio: number | undefined): BucketKey["feeTvlBand"] {
  if (ratio === undefined) return "lt_0_05";
  if (ratio < 0.05) return "lt_0_05";
  if (ratio <= 0.2) return "0_05_to_0_2";
  return "gt_0_2";
}

function volTvlBand(ratio: number | undefined): BucketKey["volTvlBand"] {
  if (ratio === undefined) return "lt_0_5";
  if (ratio < 0.5) return "lt_0_5";
  if (ratio <= 2) return "0_5_to_2";
  return "gt_2";
}

function riskFlagsCount(
  flags: string[] | undefined,
): BucketKey["riskFlagsCount"] {
  const n = flags?.length ?? 0;
  if (n <= 0) return 0;
  if (n === 1) return 1;
  return 2;
}

export function bucketKeyFor(features: LearningDecisionFeatures): BucketKey {
  return {
    pairClass: features.pairClass ?? "unknown",
    binStepBand: binStepBand(features.binStep),
    feeTvlBand: feeTvlBand(features.feeOverActiveTvl),
    volTvlBand: volTvlBand(features.volumeOverTvl),
    riskFlagsCount: riskFlagsCount(features.riskFlags),
  };
}

export function bucketKeyString(k: BucketKey): string {
  return [
    k.pairClass,
    k.binStepBand,
    k.feeTvlBand,
    k.volTvlBand,
    `rf${k.riskFlagsCount}`,
  ].join("|");
}

const DEFAULT_HORIZON_WEIGHTS: Record<number, number> = {
  10: 0.3,
  30: 0.5,
  120: 0.8,
  360: 1.0,
};

function horizonWeight(horizonMinutes: number, weights?: Record<number, number>): number {
  const w = weights ?? DEFAULT_HORIZON_WEIGHTS;
  return w[horizonMinutes] ?? 0.6;
}

function buildSummary(
  decision: LearningDecision,
  outcome: LearningOutcome,
): string {
  const name = decision.pool?.name ?? "?";
  const action = decision.action ?? "?";
  const horizon = outcome.horizonMinutes;
  const score = outcome.netPnlRiskScore;
  return `${name} | ${action} | h=${horizon}m | score=${score.toFixed(2)}`;
}

export class EvidenceIndex {
  private readonly decisionsStore: JsonlStore<LearningDecisionRecord>;
  private readonly outcomesStore: JsonlStore<LearningOutcomeRecord>;
  private readonly halfLifeDays: number;
  private readonly horizonWeights?: Record<number, number>;
  private buckets: Map<string, BucketEntry[]> = new Map();

  constructor(opts: EvidenceIndexOptions) {
    this.decisionsStore = opts.decisionsStore;
    this.outcomesStore = opts.outcomesStore;
    this.halfLifeDays = opts.recencyHalfLifeDays ?? 14;
    this.horizonWeights = opts.horizonWeights;
  }

  build(): void {
    const outcomesById = new Map<string, LearningOutcome[]>();
    for (const outcome of this.outcomesStore.readAll()) {
      const list = outcomesById.get(outcome.decisionId);
      if (list) {
        list.push(outcome);
      } else {
        outcomesById.set(outcome.decisionId, [outcome]);
      }
    }

    const now = Date.now();
    const nextBuckets = new Map<string, BucketEntry[]>();

    for (const decision of this.decisionsStore.readAll()) {
      const outcomes = outcomesById.get(decision.id);
      if (!outcomes || outcomes.length === 0) continue;

      const key = bucketKeyString(bucketKeyFor(decision.features));

      for (const outcome of outcomes) {
        const hWeight = horizonWeight(outcome.horizonMinutes, this.horizonWeights);
        const deltaDays = Math.max(0, (now - outcome.evaluatedAt) / 86_400_000);
        const rWeight = Math.exp(-deltaDays / this.halfLifeDays);
        const weight = hWeight * rWeight;

        const entry: BucketEntry = {
          decisionId: decision.id,
          score: outcome.netPnlRiskScore,
          weight,
          summary: buildSummary(decision, outcome),
        };

        const list = nextBuckets.get(key);
        if (list) {
          list.push(entry);
        } else {
          nextBuckets.set(key, [entry]);
        }
      }
    }

    this.buckets = nextBuckets;
  }

  private summarize(bucketKey: string, entries: BucketEntry[]): EvidenceQuery {
    if (entries.length === 0) {
      return {
        bucketKey,
        sampleSize: 0,
        avgScore: 0,
        pos: 0,
        neg: 0,
        topEvidence: [],
      };
    }

    let weightedSum = 0;
    let weightTotal = 0;
    let pos = 0;
    let neg = 0;

    for (const e of entries) {
      const contribution = e.score * e.weight;
      weightedSum += contribution;
      weightTotal += e.weight;
      if (contribution > 0.05) pos += 1;
      else if (contribution < -0.05) neg += 1;
    }

    const avgScore = weightTotal === 0 ? 0 : weightedSum / weightTotal;

    const topEvidence = [...entries]
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 3)
      .map((e) => ({
        decisionId: e.decisionId,
        score: e.score,
        summary: e.summary,
      }));

    return {
      bucketKey,
      sampleSize: entries.length,
      avgScore,
      pos,
      neg,
      topEvidence,
    };
  }

  query(features: LearningDecisionFeatures): EvidenceQuery {
    const key = bucketKeyString(bucketKeyFor(features));
    const entries = this.buckets.get(key) ?? [];
    return this.summarize(key, entries);
  }

  allBuckets(): EvidenceQuery[] {
    const results: EvidenceQuery[] = [];
    for (const [key, entries] of this.buckets) {
      results.push(this.summarize(key, entries));
    }
    results.sort((a, b) => b.avgScore - a.avgScore);
    return results;
  }
}
