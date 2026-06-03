// Standalone CLI: scans the 4 learning JSONL files + closed-positions and prints
// a single LearningHealthReport JSON to stdout. Pure read-only, no network.
// Invoke: `node --import tsx scripts/learning-health.ts > data/learning-health.json`
// Exit 0 on success, 1 on any throw. Designed for cron / loop / manual runs.

import { loadConfig } from "../src/config/config.js";
import { JsonlStore } from "../src/learning/jsonl-store.js";
import type {
  LearningDecision,
  LearningOutcome,
  ShadowScore,
  LearningLesson,
} from "../src/types/index.js";

interface LearningHealthReport {
  ts: number;
  uptime_hours: number;
  decisions: {
    total: number;
    byKind: Record<"screener" | "manager", number>;
    byAction: Record<string, number>;
    uniquePools: number;
    growthLastHour: number;
  };
  outcomes: {
    total: number;
    byHorizon: Record<string, number>;
    coverage: {
      eligibleDecisions: number;
      fullyLabeled: number;
      coveragePct: number;
    };
    idempotencyOk: boolean;
  };
  shadowScores: {
    total: number;
    bucketsWithScore: number;
    expectedScoreStats: {
      mean: number;
      stdev: number;
      min: number;
      max: number;
    };
    disagreements: { total: number; avgMagnitude: number };
  };
  lessons: {
    total: number;
    byCohort: number;
    byClosedPosition: number;
    duplicateRiskPairs: Array<{ a: string; b: string; jaccard: number }>;
    averageTagsPerLesson: number;
  };
  acceptanceGates: {
    decisionsAbove100: boolean;
    outcomesAllHorizonsPresent: boolean;
    shadowScoresNotNoise: boolean;
    lessonsNotDuplicate: boolean;
    uptimeAbove24h: boolean;
    readyForV11: boolean;
  };
}

function stdev(vals: number[]): number {
  if (vals.length === 0) return 0;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const v = vals.reduce((acc, x) => acc + (x - m) ** 2, 0) / vals.length;
  return Math.sqrt(v);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function buildReport(): LearningHealthReport {
  const config = loadConfig();
  const now = Date.now();
  const horizonsCfg = config.learning.horizonsMinutes;
  const maxHorizonMs =
    (horizonsCfg.length > 0 ? Math.max(...horizonsCfg) : 360) * 60_000;

  const decisionsStore = new JsonlStore<LearningDecision>(
    config.learning.files.decisions,
  );
  const outcomesStore = new JsonlStore<LearningOutcome>(
    config.learning.files.outcomes,
  );
  const shadowStore = new JsonlStore<ShadowScore>(
    config.learning.files.shadowScores,
  );
  const lessonsStore = new JsonlStore<LearningLesson>(
    config.learning.files.lessons,
  );

  const decisions = decisionsStore.readAll();
  const outcomes = outcomesStore.readAll();
  const shadows = shadowStore.readAll();
  const lessons = lessonsStore.readAll();

  // --- decisions ---
  const byKind: Record<"screener" | "manager", number> = {
    screener: 0,
    manager: 0,
  };
  const byAction: Record<string, number> = {};
  const poolSet = new Set<string>();
  let earliestTs = Number.POSITIVE_INFINITY;
  let growthLastHour = 0;
  const hourAgo = now - 3_600_000;

  for (const d of decisions) {
    if (d.kind === "screener" || d.kind === "manager") {
      byKind[d.kind] += 1;
    }
    byAction[d.action] = (byAction[d.action] ?? 0) + 1;
    if (d.pool?.address) poolSet.add(d.pool.address);
    if (typeof d.timestamp === "number") {
      if (d.timestamp < earliestTs) earliestTs = d.timestamp;
      if (d.timestamp >= hourAgo) growthLastHour += 1;
    }
  }

  const uptimeHours =
    decisions.length === 0 || !Number.isFinite(earliestTs)
      ? 0
      : (now - earliestTs) / 3_600_000;

  // --- outcomes ---
  const byHorizon: Record<string, number> = {};
  const pairCounts = new Map<string, number>();
  for (const o of outcomes) {
    const key = String(o.horizonMinutes);
    byHorizon[key] = (byHorizon[key] ?? 0) + 1;
    const pairKey = `${o.decisionId}|${o.horizonMinutes}`;
    pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);
  }
  let idempotencyOk = true;
  for (const c of pairCounts.values()) {
    if (c > 1) {
      idempotencyOk = false;
      break;
    }
  }

  const eligibleDecisionIds = new Set<string>();
  for (const d of decisions) {
    if (d.kind !== "screener") continue;
    if (typeof d.timestamp !== "number") continue;
    if (now - d.timestamp >= maxHorizonMs) {
      eligibleDecisionIds.add(d.id);
    }
  }

  // Outcomes indexed by decisionId -> set of horizons
  const outcomeHorizonsById = new Map<string, Set<number>>();
  for (const o of outcomes) {
    let s = outcomeHorizonsById.get(o.decisionId);
    if (!s) {
      s = new Set<number>();
      outcomeHorizonsById.set(o.decisionId, s);
    }
    s.add(o.horizonMinutes);
  }

  let fullyLabeled = 0;
  for (const id of eligibleDecisionIds) {
    const s = outcomeHorizonsById.get(id);
    if (!s) continue;
    let all = true;
    for (const h of horizonsCfg) {
      if (!s.has(h)) {
        all = false;
        break;
      }
    }
    if (all) fullyLabeled += 1;
  }
  const eligibleCount = eligibleDecisionIds.size;
  const coveragePct = fullyLabeled / Math.max(eligibleCount, 1);

  // --- shadow scores ---
  const bucketSet = new Set<string>();
  const expectedVals: number[] = [];
  let disagreementCount = 0;
  let disagreementMagSum = 0;
  for (const s of shadows) {
    if (s.bucketKey) bucketSet.add(s.bucketKey);
    if (typeof s.expectedScore === "number") expectedVals.push(s.expectedScore);
    if (s.disagreement) {
      disagreementCount += 1;
      disagreementMagSum += s.disagreement.magnitude ?? 0;
    }
  }
  const expectedScoreStats =
    expectedVals.length === 0
      ? { mean: 0, stdev: 0, min: 0, max: 0 }
      : {
          mean: expectedVals.reduce((a, b) => a + b, 0) / expectedVals.length,
          stdev: stdev(expectedVals),
          min: Math.min(...expectedVals),
          max: Math.max(...expectedVals),
        };
  const avgMagnitude =
    disagreementCount === 0 ? 0 : disagreementMagSum / disagreementCount;

  // --- lessons ---
  let byCohort = 0;
  let byClosed = 0;
  let totalTags = 0;
  const lessonTagSets: Array<{ id: string; tags: Set<string> }> = [];
  for (const l of lessons) {
    if (l.source === "cohort") byCohort += 1;
    else if (l.source === "closed_position") byClosed += 1;
    const tags = Array.isArray(l.tags) ? l.tags : [];
    totalTags += tags.length;
    lessonTagSets.push({
      id: l.id,
      tags: new Set(tags.map((t) => t.toLowerCase())),
    });
  }
  const averageTagsPerLesson =
    lessons.length === 0 ? 0 : totalTags / lessons.length;

  const duplicatePairs: Array<{ a: string; b: string; jaccard: number }> = [];
  for (let i = 0; i < lessonTagSets.length; i++) {
    for (let j = i + 1; j < lessonTagSets.length; j++) {
      const a = lessonTagSets[i];
      const b = lessonTagSets[j];
      if (!a || !b) continue;
      const jc = jaccard(a.tags, b.tags);
      if (jc >= 0.9) {
        duplicatePairs.push({ a: a.id, b: b.id, jaccard: jc });
      }
    }
  }
  duplicatePairs.sort((x, y) => y.jaccard - x.jaccard);
  const duplicateRiskPairs = duplicatePairs.slice(0, 20);

  // --- acceptance gates ---
  const decisionsAbove100 = decisions.length >= 100;
  const outcomesAllHorizonsPresent =
    horizonsCfg.length > 0 &&
    horizonsCfg.every((h) => (byHorizon[String(h)] ?? 0) >= 1);
  const shadowScoresNotNoise =
    shadows.length >= 5 &&
    expectedScoreStats.stdev >= 0.05 &&
    expectedScoreStats.stdev <= 0.5;
  const lessonsNotDuplicate = duplicateRiskPairs.length === 0;
  const uptimeAbove24h = uptimeHours >= 24;
  const readyForV11 =
    decisionsAbove100 &&
    outcomesAllHorizonsPresent &&
    shadowScoresNotNoise &&
    lessonsNotDuplicate &&
    uptimeAbove24h;

  return {
    ts: now,
    uptime_hours: uptimeHours,
    decisions: {
      total: decisions.length,
      byKind,
      byAction,
      uniquePools: poolSet.size,
      growthLastHour,
    },
    outcomes: {
      total: outcomes.length,
      byHorizon,
      coverage: {
        eligibleDecisions: eligibleCount,
        fullyLabeled,
        coveragePct,
      },
      idempotencyOk,
    },
    shadowScores: {
      total: shadows.length,
      bucketsWithScore: bucketSet.size,
      expectedScoreStats,
      disagreements: { total: disagreementCount, avgMagnitude },
    },
    lessons: {
      total: lessons.length,
      byCohort,
      byClosedPosition: byClosed,
      duplicateRiskPairs,
      averageTagsPerLesson,
    },
    acceptanceGates: {
      decisionsAbove100,
      outcomesAllHorizonsPresent,
      shadowScoresNotNoise,
      lessonsNotDuplicate,
      uptimeAbove24h,
      readyForV11,
    },
  };
}

try {
  const report = buildReport();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`learning-health failed: ${msg}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
}
