// Lesson miner: derives candidate lessons from cohort buckets (EvidenceIndex)
// and from closed positions. Dedupes against existing lessons.json +
// learning-lessons.jsonl using normalized-rule equality plus a Jaccard tag-
// overlap test (threshold 0.7) gated by matching rule-prefix ("favor"/"avoid").
// `mine()` is idempotent — running it back-to-back should add zero new lessons.
// `context.pnlUsd` carries the avg-outcome proxy for cohort lessons; closed-
// position lessons carry the real realizedPnlUsd. No async work in v1.

import type {
  LearningLesson,
  LessonEvidence,
  ClosedPosition,
} from "../types/index.js";
import type { LessonStore } from "../agents/lesson-store.js";
import type { ClosedPositionStore } from "../agents/closed-position-store.js";
import type { JsonlStore } from "./jsonl-store.js";
import type { EvidenceIndex } from "./evidence-index.js";
import { childLogger } from "../utils/logger.js";
import { scoreNetPnlRisk } from "./score-net-pnl-risk.js";

const log = childLogger("lesson-miner");

const JACCARD_THRESHOLD = 0.7;

export interface LessonMinerOptions {
  lessonStore: LessonStore;
  evidenceLessonsStore: JsonlStore<LearningLesson & Record<string, unknown>>;
  index: EvidenceIndex;
  closedStore: ClosedPositionStore;
  /** Minimum sampleSize to mine a cohort lesson. */
  minCohortSamples: number;
  /** Minimum |avgScore| to mine a cohort lesson. */
  minCohortAbsAvg: number;
}

export interface LessonMinerResult {
  added: number;
  deduped: number;
}

interface CandidateBuild {
  rule: string;
  tags: string[];
  source: "cohort" | "closed_position";
  poolName: string;
  evidence: LessonEvidence;
  avgOutcome: number;
}

function normalizeRule(rule: string): string {
  return rule.trim().toLowerCase().replace(/\s+/g, " ");
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

function rulePrefix(rule: string): string {
  const norm = normalizeRule(rule);
  const first = norm.split(" ")[0] ?? "";
  return first.replace(/[:,]+$/g, "");
}

function generateLessonId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `LL-${date}-${rand}`;
}

function buildLearningLesson(build: CandidateBuild): LearningLesson {
  const positive = build.avgOutcome > 0 ? build.rule : null;
  const mistake = build.avgOutcome < 0 ? build.rule : null;
  return {
    id: build.evidence.lessonId,
    timestamp: Date.now(),
    poolName: build.poolName,
    tags: build.tags,
    positiveTakeaway: positive,
    mistake,
    ruleForFuture: build.rule,
    context: {
      entry: "",
      exit: "",
      pnlUsd: build.avgOutcome,
    },
    evidence: build.evidence,
    source: build.source,
  };
}

interface ExistingLesson {
  rule: string;
  tags: string[];
}

export class LessonMiner {
  private readonly lessonStore: LessonStore;
  private readonly evidenceLessonsStore: JsonlStore<
    LearningLesson & Record<string, unknown>
  >;
  private readonly index: EvidenceIndex;
  private readonly closedStore: ClosedPositionStore;
  private readonly minCohortSamples: number;
  private readonly minCohortAbsAvg: number;

  constructor(opts: LessonMinerOptions) {
    this.lessonStore = opts.lessonStore;
    this.evidenceLessonsStore = opts.evidenceLessonsStore;
    this.index = opts.index;
    this.closedStore = opts.closedStore;
    this.minCohortSamples = opts.minCohortSamples;
    this.minCohortAbsAvg = opts.minCohortAbsAvg;
  }

  async mine(): Promise<LessonMinerResult> {
    const existingNormalized = new Set<string>();
    const existingLessons: ExistingLesson[] = [];

    for (const lesson of this.lessonStore.list()) {
      const norm = normalizeRule(lesson.ruleForFuture);
      existingNormalized.add(norm);
      existingLessons.push({ rule: lesson.ruleForFuture, tags: lesson.tags });
    }
    const existingEvidenceLessons = this.evidenceLessonsStore.readAll();
    const existingLessonIds = new Set<string>();
    for (const lesson of existingEvidenceLessons) {
      const norm = normalizeRule(lesson.ruleForFuture);
      existingNormalized.add(norm);
      existingLessons.push({ rule: lesson.ruleForFuture, tags: lesson.tags });
      existingLessonIds.add(lesson.id);
    }

    const isDuplicate = (
      candidateRule: string,
      candidateTags: string[],
    ): boolean => {
      const normCand = normalizeRule(candidateRule);
      if (existingNormalized.has(normCand)) return true;

      const candSet = new Set(candidateTags.map((t) => t.toLowerCase()));
      const candPrefix = rulePrefix(candidateRule);

      for (const existing of existingLessons) {
        const existSet = new Set(existing.tags.map((t) => t.toLowerCase()));
        const overlap = jaccard(candSet, existSet);
        if (overlap < JACCARD_THRESHOLD) continue;
        const existPrefix = rulePrefix(existing.rule);
        if (existPrefix === candPrefix && existPrefix.length > 0) {
          return true;
        }
      }
      return false;
    };

    const addCandidate = (candidate: CandidateBuild): boolean => {
      if (isDuplicate(candidate.rule, candidate.tags)) {
        return false;
      }
      const lesson = buildLearningLesson(candidate);
      this.evidenceLessonsStore.append(
        lesson as LearningLesson & Record<string, unknown>,
      );
      existingNormalized.add(normalizeRule(lesson.ruleForFuture));
      existingLessons.push({
        rule: lesson.ruleForFuture,
        tags: lesson.tags,
      });
      return true;
    };

    let added = 0;
    let deduped = 0;

    // 1) Cohort lessons.
    this.index.build();
    for (const bucket of this.index.allBuckets()) {
      if (bucket.sampleSize < this.minCohortSamples) continue;
      if (Math.abs(bucket.avgScore) < this.minCohortAbsAvg) continue;

      const direction: "favor" | "avoid" =
        bucket.avgScore > 0 ? "favor" : "avoid";
      const rule = `${direction} cohort [${bucket.bucketKey}] — avg=${bucket.avgScore.toFixed(2)} over n=${bucket.sampleSize}`;
      const tags = bucket.bucketKey.split("|");

      const bestExamples = bucket.topEvidence
        .filter((e) => e.score > 0)
        .slice(0, 3)
        .map((e) => e.summary);
      const worstExamples = bucket.topEvidence
        .filter((e) => e.score < 0)
        .slice(0, 3)
        .map((e) => e.summary);

      const evidence: LessonEvidence = {
        lessonId: generateLessonId(),
        sampleSize: bucket.sampleSize,
        avgOutcome: bucket.avgScore,
        bestExamples,
        worstExamples,
        applicability: { tags },
      };

      const candidate: CandidateBuild = {
        rule,
        tags,
        source: "cohort",
        poolName: "cohort",
        evidence,
        avgOutcome: bucket.avgScore,
      };

      if (addCandidate(candidate)) {
        added += 1;
      } else {
        deduped += 1;
      }
    }

    // 2) Closed-position lessons (idempotent).
    const lessonStoreIds = new Set(this.lessonStore.list().map((l) => l.id));

    for (const closed of this.closedStore.list()) {
      if (
        closed.lessonId !== undefined &&
        closed.lessonId.length > 0 &&
        (lessonStoreIds.has(closed.lessonId) ||
          existingLessonIds.has(closed.lessonId))
      ) {
        continue;
      }

      const candidate = this.buildClosedCandidate(closed);
      if (addCandidate(candidate)) {
        added += 1;
        existingLessonIds.add(candidate.evidence.lessonId);
      } else {
        deduped += 1;
      }
    }

    log.info({ added, deduped }, "lesson miner pass complete");
    return { added, deduped };
  }

  private buildClosedCandidate(closed: ClosedPosition): CandidateBuild {
    const avgOutcome = clamp(
      scoreNetPnlRisk({
        realizedPnlUsd: closed.realizedPnlUsd,
        realizedFeesUsd: closed.totalFeesUsdEarned,
        realizedIlUsd: closed.realizedIlUsd,
        positionSizeUsd: closed.position.entryValueUsd,
        outOfRangeMinutes: closed.finalEvaluation?.outOfRangeMinutes,
      }),
      -1,
      1,
    );
    const direction: "favor" | "avoid" = avgOutcome < 0 ? "avoid" : "favor";
    const rule = `${direction}: ${closed.position.poolName} closed at ${closed.exitReason} (pnl=${closed.realizedPnlUsd.toFixed(2)}, score=${avgOutcome.toFixed(2)} after ${closed.ageMinutes}m)`;

    const tokenTags: string[] = [];
    const xSymbol = closed.position.tokenX?.symbol;
    const ySymbol = closed.position.tokenY?.symbol;
    if (xSymbol) tokenTags.push(xSymbol);
    if (ySymbol) tokenTags.push(ySymbol);
    const tags = ["closed", direction, ...tokenTags];

    const evidence: LessonEvidence = {
      lessonId: generateLessonId(),
      sampleSize: 1,
      avgOutcome,
      bestExamples:
        avgOutcome >= 0
          ? [
              `${closed.position.poolName} | score=${avgOutcome.toFixed(2)} | pnl=${closed.realizedPnlUsd.toFixed(2)} | ${closed.exitReason}`,
            ]
          : [],
      worstExamples:
        avgOutcome < 0
          ? [
              `${closed.position.poolName} | score=${avgOutcome.toFixed(2)} | pnl=${closed.realizedPnlUsd.toFixed(2)} | ${closed.exitReason}`,
            ]
          : [],
      applicability: { tags, poolName: closed.position.poolName },
    };

    return {
      rule,
      tags,
      source: "closed_position",
      poolName: closed.position.poolName,
      evidence,
      avgOutcome,
    };
  }
}
