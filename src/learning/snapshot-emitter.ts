// Read-only JSONL snapshot emitter for the web dashboard.
// Aggregates current store state (counts, top patterns, recent
// disagreements, pending outcomes by horizon) into one row per emit.
// Append-only via JsonlEmitter. Never throws.

import type {
  LearningDecision,
  LearningLesson,
  LearningOutcome,
  ShadowScore,
} from "../types/index.js";
import type { JsonlStore } from "./jsonl-store.js";
import type { EvidenceIndex } from "./evidence-index.js";
import { JsonlEmitter } from "../utils/jsonl-emitter.js";
import { childLogger, type Logger } from "../utils/logger.js";

const log: Logger = childLogger("snapshot-emitter");

export interface LearningSnapshotEmitterOptions {
  filePath: string;
  decisionsStore: JsonlStore<LearningDecision & Record<string, unknown>>;
  outcomesStore: JsonlStore<LearningOutcome & Record<string, unknown>>;
  shadowStore: JsonlStore<ShadowScore & Record<string, unknown>>;
  lessonsStore: JsonlStore<LearningLesson & Record<string, unknown>>;
  index: EvidenceIndex;
  horizons: number[];
}

export interface LearningSnapshotRow {
  ts: number;
  counts: {
    decisions: number;
    outcomes: number;
    lessons: number;
    shadowScores: number;
  };
  topGoodPatterns: Array<{ bucket: string; avgScore: number; n: number }>;
  topBadPatterns: Array<{ bucket: string; avgScore: number; n: number }>;
  recentDisagreements: Array<{
    decisionId: string;
    pool: string;
    llmAction: string;
    shadowExpected: number;
    magnitude: number;
  }>;
  pendingByHorizon: Record<string, number>;
}

export class LearningSnapshotEmitter {
  private readonly opts: LearningSnapshotEmitterOptions;
  private readonly emitter: JsonlEmitter;

  constructor(opts: LearningSnapshotEmitterOptions) {
    this.opts = opts;
    this.emitter = new JsonlEmitter(opts.filePath);
  }

  emit(now?: number): LearningSnapshotRow | null {
    try {
      const nowTs = now ?? Date.now();
      const {
        decisionsStore,
        outcomesStore,
        shadowStore,
        lessonsStore,
        index,
        horizons,
      } = this.opts;

      const counts = {
        decisions: decisionsStore.count(),
        outcomes: outcomesStore.count(),
        lessons: lessonsStore.count(),
        shadowScores: shadowStore.count(),
      };

      index.build();
      const buckets = index.allBuckets();
      const topGoodPatterns = buckets
        .filter((b) => b.sampleSize >= 3 && b.avgScore > 0)
        .slice(0, 5)
        .map((b) => ({
          bucket: b.bucketKey,
          avgScore: b.avgScore,
          n: b.sampleSize,
        }));
      const topBadPatterns = buckets
        .filter((b) => b.sampleSize >= 3 && b.avgScore < 0)
        .sort((a, b) => a.avgScore - b.avgScore)
        .slice(0, 5)
        .map((b) => ({
          bucket: b.bucketKey,
          avgScore: b.avgScore,
          n: b.sampleSize,
        }));

      const cutoff = nowTs - 24 * 60 * 60 * 1000;
      const recentShadow = shadowStore.readSince(cutoff, "generatedAt");

      const decisionIndex = new Map<string, LearningDecision>();
      for (const d of decisionsStore.readAll()) decisionIndex.set(d.id, d);

      const recentDisagreements = recentShadow
        .filter((s) => s.disagreement !== undefined)
        .sort(
          (a, b) =>
            (b.disagreement?.magnitude ?? 0) - (a.disagreement?.magnitude ?? 0),
        )
        .slice(0, 10)
        .map((s) => {
          const d = decisionIndex.get(s.decisionId);
          const disagreement = s.disagreement;
          return {
            decisionId: s.decisionId,
            pool: d?.pool.name ?? "?",
            llmAction: disagreement ? String(disagreement.llmAction) : "?",
            shadowExpected: s.expectedScore,
            magnitude: disagreement?.magnitude ?? 0,
          };
        });

      const seen = new Set<string>();
      for (const o of outcomesStore.readAll()) {
        seen.add(`${o.decisionId}|${o.horizonMinutes}`);
      }

      const pendingByHorizon: Record<string, number> = {};
      for (const h of horizons) pendingByHorizon[String(h)] = 0;

      for (const d of decisionsStore.readAll()) {
        for (const h of horizons) {
          if (nowTs - d.timestamp < h * 60_000) continue;
          if (seen.has(`${d.id}|${h}`)) continue;
          pendingByHorizon[String(h)] = (pendingByHorizon[String(h)] ?? 0) + 1;
        }
      }

      const row: LearningSnapshotRow = {
        ts: nowTs,
        counts,
        topGoodPatterns,
        topBadPatterns,
        recentDisagreements,
        pendingByHorizon,
      };

      try {
        this.emitter.append(row);
      } catch (err) {
        log.warn({ err }, "snapshot emitter append failed");
        return null;
      }

      return row;
    } catch (err) {
      log.warn({ err }, "snapshot emitter emit failed");
      return null;
    }
  }
}
