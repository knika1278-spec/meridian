import fs from "node:fs";
import path from "node:path";
import { loadRawData, type RawData } from "./data-source";
import { buildGraph } from "./build-graph";
import type {
  CandidateLite,
  ClosedLite,
  DashboardSnapshot,
  DecisionLite,
  JournalLite,
  LearningSnapshot,
  LessonLite,
  LlmRunLite,
  OutcomeLite,
  PositionLite,
  ProgressLite,
  ShadowLite,
  SignalFinding,
} from "./dashboard";

function readJsonl<T>(dir: string, file: string): T[] {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(full, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      /* skip */
    }
  }
  return out;
}

function readJson<T>(dir: string, file: string): T | null {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, "utf-8")) as T;
  } catch {
    return null;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function last<T>(arr: T[], n: number): T[] {
  return arr.slice(Math.max(0, arr.length - n)).reverse();
}

export function buildDashboard(
  raw: RawData = loadRawData(),
): DashboardSnapshot {
  const dir = raw.dataDir;
  const warnings = [...raw.warnings];
  const stats = buildGraph(raw).stats;

  const decisionName = new Map<string, string>();
  for (const d of raw.decisions) {
    if (d.pool?.name) decisionName.set(d.id, d.pool.name);
  }

  // ---- Screening (candidates + llm-runs) ----------------------------------
  const candRecords = readJsonl<{
    ts: number;
    cycleId: string;
    stage: string;
    candidates: Array<Record<string, unknown>>;
  }>(dir, "candidates.jsonl");
  const finals = candRecords.filter((r) => r.stage === "final");
  const cycleIds = new Set(candRecords.map((r) => r.cycleId));
  const lastFinal = finals[finals.length - 1] ?? null;

  const candidates: CandidateLite[] = (lastFinal?.candidates ?? []).map((c) => {
    const pool = (c.pool ?? {}) as Record<string, unknown>;
    const decision = (c.decision ?? {}) as Record<string, unknown>;
    return {
      address: str(pool.address) ?? "",
      name: str(pool.name) ?? "?",
      status: str(c.status),
      filtersPassed:
        typeof c.filtersPassed === "boolean" ? c.filtersPassed : undefined,
      organicScore: num(c.organicScore),
      tvlUsd: num(pool.tvlUsd),
      feeToTvlRatio: num(pool.feeToTvlRatio),
      action: str(decision.action),
      confidence: num(decision.confidence),
    };
  });

  const llmRecords = readJsonl<Record<string, unknown>>(dir, "llm-runs.jsonl");
  const llmRuns: LlmRunLite[] = last(llmRecords, 40).map((r) => {
    const decision = (r.decision ?? {}) as Record<string, unknown>;
    return {
      ts: num(r.ts) ?? 0,
      poolName: str(r.poolName) ?? "?",
      model: str(r.model) ?? "?",
      promptTokens: num(r.promptTokens) ?? 0,
      completionTokens: num(r.completionTokens) ?? 0,
      latencyMs: num(r.latencyMs) ?? 0,
      costUsd: num(r.costUsd) ?? 0,
      action: str(decision.action),
      confidence: num(decision.confidence),
    };
  });
  const byAction: Record<string, number> = {};
  let costUsd = 0;
  let latencySum = 0;
  for (const r of llmRecords) {
    costUsd += num(r.costUsd) ?? 0;
    latencySum += num(r.latencyMs) ?? 0;
    const a = str((r.decision as Record<string, unknown>)?.action) ?? "UNKNOWN";
    byAction[a] = (byAction[a] ?? 0) + 1;
  }

  // ---- Decisions distribution ---------------------------------------------
  const decisionCounts: Record<string, number> = {};
  for (const d of raw.decisions) {
    decisionCounts[d.action ?? "?"] =
      (decisionCounts[d.action ?? "?"] ?? 0) + 1;
  }

  // ---- Positions -----------------------------------------------------------
  const mapPosition = (p: Record<string, unknown>): PositionLite => {
    const tx = (p.tokenX ?? {}) as Record<string, unknown>;
    const ty = (p.tokenY ?? {}) as Record<string, unknown>;
    const eval_ = (p.lastEvaluation ?? {}) as Record<string, unknown>;
    const fees = (eval_.claimableFees ?? {}) as Record<string, unknown>;
    return {
      positionPubkey: str(p.positionPubkey) ?? str(p.publicKey) ?? "?",
      poolName: str(p.poolName),
      tokens: [str(tx.symbol), str(ty.symbol)].filter((t): t is string => !!t),
      openedAt: num(p.openedAt) ?? num(p.createdAt),
      sizeUsd: num(p.sizeUsd) ?? num(p.depositUsd),
      inRangePct: num(p.inRangePct) ?? num(eval_.inRangePct),
      pnlUsd: num(p.pnlUsd) ?? num(eval_.pnlUsd),
      status: str(p.status),
      claimableFeesUsd: num(fees.usdValue),
      pnlPct: num(eval_.pnlPct),
      ageMinutes: num(eval_.ageMinutes),
      outOfRangeMinutes: num(eval_.outOfRangeMinutes),
    };
  };
  const open: PositionLite[] = (
    raw.positions as unknown as Record<string, unknown>[]
  ).map(mapPosition);
  const closed: ClosedLite[] = (
    raw.closed as unknown as Record<string, unknown>[]
  ).map((c) => {
    const pos = (c.position ?? {}) as Record<string, unknown>;
    return {
      positionPubkey: str(pos.positionPubkey) ?? "?",
      poolName: str(pos.poolName),
      closedAt: num(c.closedAt),
      exitReason: str(c.exitReason),
      pnlUsd: num(c.pnlUsd),
    };
  });

  // ---- Journal helpers -----------------------------------------------------
  const toJournalLite = (j: (typeof raw.journals)[number]): JournalLite => ({
    id: j.id,
    ts: j.timestamp ?? 0,
    actor: j.actor ?? "?",
    event: j.event ?? "?",
    status: j.status ?? "?",
    summary: j.summary ?? "",
    action: j.action,
    poolName: j.subject?.poolName,
  });
  const sortedJournals = [...raw.journals].sort(
    (a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0),
  );
  const recentJournal = sortedJournals.slice(0, 12).map(toJournalLite);
  const managerEvents = sortedJournals
    .filter((j) => j.actor === "MANAGER")
    .slice(0, 30)
    .map(toJournalLite);

  // ---- Management progress + lessons --------------------------------------
  const progressRecords = readJsonl<Record<string, unknown>>(
    dir,
    "progress.jsonl",
  );
  const progress: ProgressLite[] = last(progressRecords, 30).map((p) => ({
    id: str(p.id) ?? "?",
    cycleId: str(p.cycleId) ?? "?",
    source: str(p.source) ?? "?",
    phase: str(p.phase) ?? "?",
    status: str(p.status) ?? "?",
    percent: num(p.percent) ?? 0,
    message: str(p.message) ?? "",
    updatedAt: num(p.updatedAt) ?? 0,
  }));
  const lessons: LessonLite[] = raw.lessons.map((l) => ({
    id: l.id,
    ts: l.timestamp ?? 0,
    poolName: l.poolName,
    ruleForFuture: l.ruleForFuture ?? "",
    tags: l.tags ?? [],
  }));

  // ---- Learning ------------------------------------------------------------
  const snapRecords = readJsonl<LearningSnapshot>(
    dir,
    "learning-snapshot.jsonl",
  );
  const snapshot = snapRecords[snapRecords.length - 1] ?? null;

  const sw = readJson<{
    topPositive?: SignalFinding[];
    topNegative?: SignalFinding[];
  }>(dir, "signal-weights.json");
  const signalWeights = sw
    ? { topPositive: sw.topPositive ?? [], topNegative: sw.topNegative ?? [] }
    : null;

  const disagreements: ShadowLite[] = raw.shadows
    .filter((s) => s.disagreement)
    .sort((a, b) => (b.generatedAt ?? 0) - (a.generatedAt ?? 0))
    .slice(0, 30)
    .map((s) => ({
      decisionId: s.decisionId,
      poolName: decisionName.get(s.decisionId),
      bucketKey: s.bucketKey ?? "?",
      expectedScore: s.expectedScore ?? 0,
      riskScore: s.riskScore ?? 0,
      sampleSize: s.sampleSize ?? 0,
      confidence: s.confidence ?? 0,
      ts: s.generatedAt ?? 0,
      disagreement: s.disagreement
        ? `${s.disagreement.shadowRecommendation} vs ${s.disagreement.llmAction}`
        : undefined,
    }));

  const outcomes: OutcomeLite[] = [...raw.outcomes]
    .sort((a, b) => (b.evaluatedAt ?? 0) - (a.evaluatedAt ?? 0))
    .slice(0, 40)
    .map((o) => ({
      decisionId: o.decisionId,
      poolName: decisionName.get(o.decisionId),
      horizonMinutes: o.horizonMinutes,
      kind: o.kind ?? "?",
      netPnlRiskScore: o.netPnlRiskScore,
      evaluatedAt: o.evaluatedAt ?? 0,
    }));

  const decisions: DecisionLite[] = [...raw.decisions]
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, 40)
    .map((d) => ({
      id: d.id,
      ts: d.timestamp ?? 0,
      poolName: d.pool?.name ?? "?",
      kind: d.kind ?? "?",
      action: d.action ?? "?",
      confidence: d.confidence,
    }));

  // ---- Realtime ------------------------------------------------------------
  const rt = readJson<{ events?: Array<{ timestamp?: number }> }>(
    dir,
    "realtime-signals.json",
  );
  const rtEvents = rt?.events ?? [];
  const lastTs =
    rtEvents.length > 0
      ? (num(rtEvents[rtEvents.length - 1]?.timestamp) ?? null)
      : null;

  // ---- dryRun derivation ---------------------------------------------------
  let dryRun: boolean | null = null;
  for (const j of sortedJournals) {
    if (typeof j.dryRun === "boolean") {
      dryRun = j.dryRun;
      break;
    }
  }

  return {
    generatedAt: Date.now(),
    dataDir: dir,
    warnings,
    dryRun,
    overview: {
      openPositions: open.length,
      closedPositions: closed.length,
      screeningCycles: cycleIds.size,
      lastCycle: lastFinal
        ? {
            id: lastFinal.cycleId,
            ts: lastFinal.ts,
            passed: candidates.filter((c) => c.filtersPassed).length,
            total: candidates.length,
          }
        : null,
      decisionCounts,
      memory: {
        memories: stats.memories,
        linked: stats.linked,
        clusterOnly: stats.clusterOnly,
        isolated: stats.isolated,
      },
      learning: snapshot,
      realtime: { events: rtEvents.length, lastTs },
      recentJournal,
    },
    screening: {
      lastCycleId: lastFinal?.cycleId ?? null,
      candidates,
      llmRuns,
      totals: {
        costUsd,
        calls: llmRecords.length,
        avgLatencyMs: llmRecords.length ? latencySum / llmRecords.length : 0,
        byAction,
      },
    },
    positions: { open, closed },
    management: { events: managerEvents, progress, lessons },
    learning: { snapshot, signalWeights, disagreements, outcomes, decisions },
  };
}
