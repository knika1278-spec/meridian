import fs from "node:fs";
import path from "node:path";
import type { JsonlStore } from "../learning/jsonl-store.js";
import type { DecisionJournal } from "./decision-journal.js";
import type {
  ClosedPosition,
  DecisionJournalEntry,
  LearningDecision,
  LearningLesson,
  Lesson,
  Position,
  PromptMemoryBundle,
  PromptMemoryItem,
  ScreeningResult,
  ShadowScore,
  UserConfig,
} from "../types/index.js";

// AUDIT FIX [C2-MITIGATED]: minimum normalized cohort score (0..1) for a learning
// lesson to be injected into LLM prompts. Outcome scores are [-1,1] (score-net-pnl-risk);
// normalized = (raw + 1) / 2. 0.7 keeps only clearly-favorable cohorts out of the prompt
// so toxic/negative evidence can no longer push the LLM toward rug-prone pools.
const DEFAULT_EVIDENCE_MIN_NORM_SCORE = 0.7;

export interface MemoryRouterOptions {
  config: UserConfig;
  journal: DecisionJournal;
  learningDecisionStore?: JsonlStore<
    LearningDecision & Record<string, unknown>
  >;
  learningLessonsStore?: JsonlStore<LearningLesson & Record<string, unknown>>;
  shadowStore?: JsonlStore<ShadowScore & Record<string, unknown>>;
}

interface MemoryTarget {
  poolAddress?: string;
  poolName?: string;
  positionPubkey?: string;
  tokenSymbols: string[];
}

interface Scored<T> {
  item: T;
  relevance: number;
}

const MS_PER_DAY = 24 * 60 * 60_000;

export class MemoryRouter {
  private readonly config: UserConfig;
  private readonly journal: DecisionJournal;
  private readonly learningDecisionStore?: JsonlStore<
    LearningDecision & Record<string, unknown>
  >;
  private readonly learningLessonsStore?: JsonlStore<
    LearningLesson & Record<string, unknown>
  >;
  private readonly shadowStore?: JsonlStore<
    ShadowScore & Record<string, unknown>
  >;

  constructor(opts: MemoryRouterOptions) {
    this.config = opts.config;
    this.journal = opts.journal;
    this.learningDecisionStore = opts.learningDecisionStore;
    this.learningLessonsStore = opts.learningLessonsStore;
    this.shadowStore = opts.shadowStore;
  }

  forScreener(result: ScreeningResult): PromptMemoryBundle {
    if (!this.config.memory.enabled || !this.config.memory.injectIntoScreener) {
      return emptyBundle();
    }
    const target: MemoryTarget = {
      poolAddress: result.pool.address,
      poolName: result.pool.name,
      tokenSymbols: [result.pool.tokenX.symbol, result.pool.tokenY.symbol],
    };
    return this.buildBundle(target);
  }

  forManager(position: Position): PromptMemoryBundle {
    if (!this.config.memory.enabled || !this.config.memory.injectIntoManager) {
      return emptyBundle();
    }
    const target: MemoryTarget = {
      poolAddress: position.poolAddress,
      poolName: position.poolName,
      positionPubkey: position.positionPubkey,
      tokenSymbols: [position.tokenX.symbol, position.tokenY.symbol],
    };
    return this.buildBundle(target);
  }

  forPostMortem(
    closed: ClosedPosition,
    existingSimilarLessons: Lesson[] = [],
  ): PromptMemoryBundle {
    if (
      !this.config.memory.enabled ||
      !this.config.memory.injectIntoPostMortem
    ) {
      return emptyBundle();
    }
    const target: MemoryTarget = {
      poolAddress: closed.position.poolAddress,
      poolName: closed.position.poolName,
      positionPubkey: closed.position.positionPubkey,
      tokenSymbols: [
        closed.position.tokenX.symbol,
        closed.position.tokenY.symbol,
      ],
    };
    const bundle = this.buildBundle(target);
    const already = new Set(bundle.lessons.map((item) => item.id));
    const similarItems = existingSimilarLessons
      .filter((lesson) => !already.has(lesson.id))
      .map((lesson) =>
        lessonToPromptItem(
          lesson,
          scoreLesson(lesson, target, this.config.memory.recencyBonusDays),
        ),
      );
    bundle.lessons = limitItems(
      [...similarItems, ...bundle.lessons],
      this.config.memory.maxPromptItems,
    );
    return bundle;
  }

  private buildBundle(target: MemoryTarget): PromptMemoryBundle {
    const maxItems = this.config.memory.maxPromptItems;
    if (maxItems <= 0) return emptyBundle();
    return {
      recentDecisions: this.recentDecisionItems(target, maxItems),
      lessons: this.lessonItems(target, maxItems),
      learningEvidence: this.learningEvidenceItems(target, maxItems),
    };
  }

  private recentDecisionItems(
    target: MemoryTarget,
    maxItems: number,
  ): PromptMemoryItem[] {
    const recentLimit = Math.max(this.config.memory.recentLimit, maxItems);
    const scored = this.journal
      .readAll()
      .map((entry) => ({
        item: entry,
        relevance: scoreJournal(
          entry,
          target,
          this.config.memory.recencyBonusDays,
        ),
      }))
      .filter((scoredEntry) => scoredEntry.relevance > 0)
      .sort(sortScoredByRelevanceAndTime((entry) => entry.timestamp))
      .slice(0, recentLimit)
      .map(({ item, relevance }) => journalToPromptItem(item, relevance));
    return limitItems(scored, maxItems);
  }

  private lessonItems(
    target: MemoryTarget,
    maxItems: number,
  ): PromptMemoryItem[] {
    const lessons = [
      ...readLessonsFile(this.config.manager.lessonsFile),
      ...this.closedPositionLearningLessons(),
    ];
    const scored = lessons
      .map((lesson) => ({
        item: lesson,
        relevance: scoreLesson(
          lesson,
          target,
          this.config.memory.recencyBonusDays,
        ),
      }))
      .filter((row) => row.relevance > 0)
      .sort(sortScoredByRelevanceAndTime((lesson) => lesson.timestamp))
      .map(({ item, relevance }) => lessonToPromptItem(item, relevance));
    return limitItems(scored, maxItems);
  }

  private learningEvidenceItems(
    target: MemoryTarget,
    maxItems: number,
  ): PromptMemoryItem[] {
    const memory = this.config.memory;
    if (!memory.includeLearningEvidence) return [];

    const evidenceItems: PromptMemoryItem[] = [];
    if (this.learningLessonsStore) {
      const lessons = this.learningLessonsStore
        .readAll()
        .filter(
          (lesson) =>
            lesson.source !== "closed_position" &&
            (lesson.evidence?.sampleSize ?? 0) >= memory.minEvidenceForPrompt &&
            // AUDIT FIX [C2-MITIGATED]: only inject non-toxic evidence. Missing
            // score → excluded (fail-safe). See DEFAULT_EVIDENCE_MIN_NORM_SCORE.
            ((lesson.evidence?.avgOutcome ?? -1) + 1) / 2 >
              (this.config.memory.minEvidenceNormScore ??
                DEFAULT_EVIDENCE_MIN_NORM_SCORE),
        )
        .map((lesson) => ({
          item: lesson,
          relevance: scoreLearningLesson(
            lesson,
            target,
            this.config.memory.recencyBonusDays,
          ),
        }))
        .filter((row) => row.relevance > 0)
        .sort(sortScoredByRelevanceAndTime((lesson) => lesson.timestamp))
        .map(({ item, relevance }) =>
          learningLessonToPromptItem(item, relevance),
        );
      evidenceItems.push(...lessons);
    }

    if (this.shadowStore) {
      const decisionsById = new Map<string, LearningDecision>();
      for (const decision of this.learningDecisionStore?.readAll() ?? []) {
        decisionsById.set(decision.id, decision);
      }
      const shadow = this.shadowStore
        .readAll()
        .filter(
          (score) =>
            score.disagreement !== undefined &&
            score.sampleSize >= memory.minEvidenceForPrompt,
        )
        .map((score) => ({
          item: score,
          relevance: scoreShadow(
            score,
            decisionsById.get(score.decisionId),
            target,
            this.config.memory.recencyBonusDays,
          ),
        }))
        .filter((row) => row.relevance > 0)
        .sort(sortScoredByRelevanceAndTime((score) => score.generatedAt))
        .map(({ item, relevance }) => shadowToPromptItem(item, relevance));
      evidenceItems.push(...shadow);
    }

    return limitItems(evidenceItems, maxItems);
  }

  private closedPositionLearningLessons(): LearningLesson[] {
    if (!this.learningLessonsStore) return [];
    return this.learningLessonsStore
      .readAll()
      .filter((lesson) => lesson.source === "closed_position");
  }
}

export function hasPromptMemory(
  bundle: PromptMemoryBundle | undefined,
): boolean {
  if (!bundle) return false;
  return (
    bundle.recentDecisions.length > 0 ||
    bundle.lessons.length > 0 ||
    bundle.learningEvidence.length > 0
  );
}

function emptyBundle(): PromptMemoryBundle {
  return { recentDecisions: [], lessons: [], learningEvidence: [] };
}

function journalToPromptItem(
  entry: DecisionJournalEntry,
  relevance: number,
): PromptMemoryItem {
  return {
    id: entry.id,
    journalId: entry.id,
    kind: "journal",
    timestamp: entry.timestamp,
    summary: `${entry.actor}/${entry.event}: ${entry.summary}`,
    relevance,
    action: entry.action,
    status: entry.status,
    reasons: entry.reasons.slice(0, 3),
    risks: entry.risks.slice(0, 3),
    metrics: entry.metrics,
  };
}

function lessonToPromptItem(
  lesson: Lesson,
  relevance: number,
): PromptMemoryItem {
  return {
    id: lesson.id,
    lessonId: lesson.id,
    kind: "lesson",
    timestamp: lesson.timestamp,
    summary: lesson.ruleForFuture,
    relevance,
    reasons: [lesson.positiveTakeaway, lesson.context?.entry].filter(
      (value): value is string => !!value,
    ),
    risks: [lesson.mistake, lesson.context?.exit].filter(
      (value): value is string => !!value,
    ),
    metrics: { pnlUsd: lesson.context?.pnlUsd ?? null },
  };
}

function learningLessonToPromptItem(
  lesson: LearningLesson,
  relevance: number,
): PromptMemoryItem {
  return {
    ...lessonToPromptItem(lesson, relevance),
    kind: "learning_evidence",
    summary: `${lesson.ruleForFuture} (n=${lesson.evidence.sampleSize}, avg=${lesson.evidence.avgOutcome.toFixed(3)})`,
    metrics: {
      sampleSize: lesson.evidence.sampleSize,
      avgOutcome: lesson.evidence.avgOutcome,
      source: lesson.source,
    },
  };
}

function shadowToPromptItem(
  score: ShadowScore,
  relevance: number,
): PromptMemoryItem {
  const disagreement = score.disagreement;
  return {
    id: `shadow:${score.decisionId}`,
    evidenceId: `shadow:${score.decisionId}`,
    kind: "learning_evidence",
    timestamp: score.generatedAt,
    summary: disagreement
      ? `Shadow ${disagreement.shadowRecommendation} vs ${disagreement.llmAction} on ${score.bucketKey}`
      : `Shadow score on ${score.bucketKey}`,
    relevance,
    action: disagreement?.shadowRecommendation,
    status: "INFO",
    reasons: score.topEvidence.slice(0, 3).map((e) => e.summary),
    metrics: {
      expectedScore: score.expectedScore,
      riskScore: score.riskScore,
      sampleSize: score.sampleSize,
      confidence: score.confidence,
      magnitude: disagreement?.magnitude ?? null,
    },
  };
}

function readLessonsFile(filePath: string): Lesson[] {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return [];
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
    return Array.isArray(parsed) ? (parsed as Lesson[]) : [];
  } catch {
    return [];
  }
}

function scoreJournal(
  entry: DecisionJournalEntry,
  target: MemoryTarget,
  recencyBonusDays?: number,
): number {
  let base = 0;
  if (
    target.positionPubkey &&
    same(entry.subject.positionPubkey, target.positionPubkey)
  ) {
    base += 10;
  }
  if (
    target.poolAddress &&
    same(entry.subject.poolAddress, target.poolAddress)
  ) {
    base += 7;
  }
  if (target.poolName && same(entry.subject.poolName, target.poolName)) {
    base += 6;
  }
  base +=
    tokenOverlap(entry.subject.tokenSymbols ?? [], target.tokenSymbols) * 2;
  if (base <= 0) return 0;
  const eventBonus =
    entry.event === "NO_DEPLOY" || entry.event === "ACTION_FAILED" ? 1 : 0;
  return base + eventBonus + recencyBonus(entry.timestamp, recencyBonusDays);
}

function scoreLesson(
  lesson: Lesson,
  target: MemoryTarget,
  recencyBonusDays?: number,
): number {
  let score = 0;
  if (target.poolName && same(lesson.poolName, target.poolName)) score += 6;
  score +=
    tokenOverlap(tokensFromPoolName(lesson.poolName), target.tokenSymbols) * 2;
  score += tokenOverlap(lesson.tags, target.tokenSymbols) * 2;
  if (score <= 0) return 0;
  return score + recencyBonus(lesson.timestamp, recencyBonusDays);
}

function scoreLearningLesson(
  lesson: LearningLesson,
  target: MemoryTarget,
  recencyBonusDays?: number,
): number {
  let score = scoreLesson(lesson, target, recencyBonusDays);
  const applies = lesson.evidence?.applicability;
  if (
    applies?.poolName &&
    target.poolName &&
    same(applies.poolName, target.poolName)
  ) {
    score += 3;
  }
  score += tokenOverlap(applies?.tags ?? [], target.tokenSymbols);
  return score;
}

function scoreShadow(
  score: ShadowScore,
  decision: LearningDecision | undefined,
  target: MemoryTarget,
  recencyBonusDays?: number,
): number {
  let relevance = 0;
  if (decision) {
    if (target.poolAddress && same(decision.pool.address, target.poolAddress)) {
      relevance += 7;
    }
    if (target.poolName && same(decision.pool.name, target.poolName)) {
      relevance += 6;
    }
    relevance +=
      tokenOverlap(
        tokensFromPoolName(decision.pool.name),
        target.tokenSymbols,
      ) * 2;
  }
  if (relevance <= 0) return 0;
  return (
    relevance +
    Math.min(2, score.confidence * 2) +
    recencyBonus(score.generatedAt, recencyBonusDays)
  );
}

function limitItems(
  items: PromptMemoryItem[],
  limit: number,
): PromptMemoryItem[] {
  return [...items]
    .sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return b.timestamp - a.timestamp;
    })
    .slice(0, Math.max(0, limit));
}

function sortScoredByRelevanceAndTime<T>(
  getTimestamp: (item: T) => number,
): (a: Scored<T>, b: Scored<T>) => number {
  return (a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return getTimestamp(b.item) - getTimestamp(a.item);
  };
}

function tokenOverlap(a: string[], b: string[]): number {
  const target = new Set(b.map(normalize).filter(Boolean));
  let count = 0;
  for (const token of a.map(normalize)) {
    if (target.has(token)) count += 1;
  }
  return count;
}

function tokensFromPoolName(poolName: string | undefined): string[] {
  return (poolName ?? "")
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);
}

function recencyBonus(timestamp: number, decayDays = 15): number {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / MS_PER_DAY);
  return Math.max(0, 2 - ageDays / decayDays);
}

function same(a: string | undefined, b: string | undefined): boolean {
  return normalize(a) === normalize(b) && normalize(a).length > 0;
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
