// Darwin-lite observation layer.
// Derives lightweight signal lift from learning-decisions + outcomes.
// Observation only: never mutates thresholds, config, or execution behavior.

import fs from "node:fs";
import path from "node:path";

import type {
  LearningDecision,
  LearningDecisionFeatures,
  LearningOutcome,
  SignalWeightFinding,
  SignalWeightsSnapshot,
} from "../types/index.js";
import type { JsonlStore } from "./jsonl-store.js";
import { childLogger, type Logger } from "../utils/logger.js";

const log: Logger = childLogger("signal-weights");

type DecisionRow = LearningDecision & Record<string, unknown>;
type OutcomeRow = LearningOutcome & Record<string, unknown>;

export interface SignalWeightsOptions {
  minSamples?: number;
  maxSignals?: number;
  generatedAt?: number;
}

export interface SignalWeightsEmitterOptions {
  filePath: string;
  decisionsStore: JsonlStore<DecisionRow>;
  outcomesStore: JsonlStore<OutcomeRow>;
  minSamples: number;
  maxSignals?: number;
}

interface ScoredDecision {
  features: LearningDecisionFeatures;
  score: number;
}

export interface SignalHints {
  generatedAt: number;
  sampleSize: number;
  positive: Array<{
    signal: string;
    lift: number;
    confidence: number;
    sampleSize: number;
  }>;
  negative: Array<{
    signal: string;
    lift: number;
    confidence: number;
    sampleSize: number;
  }>;
  note: string;
}

const NUMERIC_SIGNALS: ReadonlyArray<keyof LearningDecisionFeatures> = [
  "binStep",
  "feeOverActiveTvl",
  "volumeOverTvl",
  "organicScore",
  "holders",
  "mcUsd",
  "tvlUsd",
  "rangeBinsPerSide",
];

export function computeSignalWeights(
  decisions: LearningDecision[],
  outcomes: LearningOutcome[],
  opts: SignalWeightsOptions = {},
): SignalWeightsSnapshot {
  const minSamples = Math.max(1, opts.minSamples ?? 5);
  const maxSignals = Math.max(1, opts.maxSignals ?? 5);
  const generatedAt = opts.generatedAt ?? Date.now();
  const decisionsById = new Map<string, LearningDecision>();
  for (const decision of decisions) decisionsById.set(decision.id, decision);

  const records: ScoredDecision[] = [];
  for (const outcome of outcomes) {
    const decision = decisionsById.get(outcome.decisionId);
    if (!decision) continue;
    if (!Number.isFinite(outcome.netPnlRiskScore)) continue;
    records.push({
      features: decision.features,
      score: outcome.netPnlRiskScore,
    });
  }

  const findings: SignalWeightFinding[] = [];
  findings.push(...numericFindings(records, minSamples));
  findings.push(...categoricalFindings(records, minSamples));

  const topPositive = findings
    .filter((finding) => finding.lift > 0)
    .sort(sortPositive)
    .slice(0, maxSignals);
  const topNegative = findings
    .filter((finding) => finding.lift < 0)
    .sort(sortNegative)
    .slice(0, maxSignals);

  return {
    generatedAt,
    sampleSize: records.length,
    minSamples,
    topPositive,
    topNegative,
  };
}

export class SignalWeightsEmitter {
  private readonly opts: SignalWeightsEmitterOptions;

  constructor(opts: SignalWeightsEmitterOptions) {
    this.opts = opts;
  }

  emit(now?: number): SignalWeightsSnapshot | null {
    try {
      const snapshot = computeSignalWeights(
        this.opts.decisionsStore.readAll(),
        this.opts.outcomesStore.readAll(),
        {
          minSamples: this.opts.minSamples,
          maxSignals: this.opts.maxSignals,
          generatedAt: now,
        },
      );
      fs.mkdirSync(path.dirname(path.resolve(this.opts.filePath)), {
        recursive: true,
      });
      fs.writeFileSync(
        path.resolve(this.opts.filePath),
        `${JSON.stringify(snapshot, null, 2)}\n`,
        "utf-8",
      );
      return snapshot;
    } catch (err) {
      log.warn({ err }, "signal weights emit failed");
      return null;
    }
  }
}

export function readSignalWeightsPromptHints(
  filePath: string,
  maxSignals = 3,
): SignalHints | undefined {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return undefined;
    const parsed = JSON.parse(
      fs.readFileSync(resolved, "utf-8"),
    ) as Partial<SignalWeightsSnapshot>;
    const positive = compactHints(parsed.topPositive, maxSignals);
    const negative = compactHints(parsed.topNegative, maxSignals);
    if (positive.length === 0 && negative.length === 0) return undefined;
    return {
      generatedAt: parsed.generatedAt ?? 0,
      sampleSize: parsed.sampleSize ?? 0,
      positive,
      negative,
      note: "Observation-only historical lift. Use as a weak hint, not as a hard rule or config threshold.",
    };
  } catch {
    return undefined;
  }
}

function numericFindings(
  records: ScoredDecision[],
  minSamples: number,
): SignalWeightFinding[] {
  const findings: SignalWeightFinding[] = [];
  for (const signal of NUMERIC_SIGNALS) {
    const rows = records
      .map((record) => ({
        value: record.features[signal],
        score: record.score,
      }))
      .filter(
        (row): row is { value: number; score: number } =>
          typeof row.value === "number" && Number.isFinite(row.value),
      );
    if (rows.length < minSamples) continue;
    const medianValue = median(rows.map((row) => row.value));
    if (medianValue === undefined) continue;

    const withSignal = rows.filter((row) => row.value >= medianValue);
    const withoutSignal = rows.filter((row) => row.value < medianValue);
    const finding = buildFinding({
      signal: `${String(signal)}:high`,
      withSignal: withSignal.map((row) => row.score),
      withoutSignal: withoutSignal.map((row) => row.score),
      minSamples,
    });
    if (finding) findings.push(finding);
  }
  return findings;
}

function categoricalFindings(
  records: ScoredDecision[],
  minSamples: number,
): SignalWeightFinding[] {
  const predicates: Array<{
    signal: string;
    matches: (features: LearningDecisionFeatures) => boolean;
  }> = [];

  for (const pairClass of uniqueValues(
    records
      .map((record) => record.features.pairClass)
      .filter(
        (value): value is NonNullable<LearningDecisionFeatures["pairClass"]> =>
          value !== undefined,
      ),
  )) {
    predicates.push({
      signal: `pairClass:${pairClass}`,
      matches: (features) => features.pairClass === pairClass,
    });
  }

  for (const flag of uniqueValues(
    records.flatMap((record) => record.features.riskFlags ?? []),
  )) {
    predicates.push({
      signal: `riskFlag:${flag}`,
      matches: (features) => (features.riskFlags ?? []).includes(flag),
    });
  }

  const findings: SignalWeightFinding[] = [];
  for (const predicate of predicates) {
    const withSignal = records
      .filter((record) => predicate.matches(record.features))
      .map((record) => record.score);
    const withoutSignal = records
      .filter((record) => !predicate.matches(record.features))
      .map((record) => record.score);
    const finding = buildFinding({
      signal: predicate.signal,
      withSignal,
      withoutSignal,
      minSamples,
    });
    if (finding) findings.push(finding);
  }
  return findings;
}

function buildFinding(args: {
  signal: string;
  withSignal: number[];
  withoutSignal: number[];
  minSamples: number;
}): SignalWeightFinding | null {
  const total = args.withSignal.length + args.withoutSignal.length;
  if (total < args.minSamples) return null;
  if (args.withSignal.length === 0 || args.withoutSignal.length === 0) {
    return null;
  }

  const avgWithSignal = avg(args.withSignal);
  const avgWithoutSignal = avg(args.withoutSignal);
  const lift = avgWithSignal - avgWithoutSignal;
  if (lift === 0) return null;

  return {
    signal: args.signal,
    sampleSize: args.withSignal.length,
    lift: round4(lift),
    confidence: confidence(total, lift, args.minSamples),
    avgWithSignal: round4(avgWithSignal),
    avgWithoutSignal: round4(avgWithoutSignal),
  };
}

function compactHints(
  findings: SignalWeightFinding[] | undefined,
  maxSignals: number,
): SignalHints["positive"] {
  return (findings ?? []).slice(0, Math.max(0, maxSignals)).map((finding) => ({
    signal: finding.signal,
    lift: finding.lift,
    confidence: finding.confidence,
    sampleSize: finding.sampleSize,
  }));
}

function confidence(
  totalSamples: number,
  lift: number,
  minSamples: number,
): number {
  const sampleConfidence = Math.min(
    1,
    totalSamples / Math.max(minSamples * 3, 1),
  );
  const liftConfidence = Math.min(1, Math.abs(lift));
  return round4(sampleConfidence * liftConfidence);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return undefined;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function sortPositive(a: SignalWeightFinding, b: SignalWeightFinding): number {
  const scoreB = b.lift * b.confidence;
  const scoreA = a.lift * a.confidence;
  return scoreB - scoreA || b.sampleSize - a.sampleSize;
}

function sortNegative(a: SignalWeightFinding, b: SignalWeightFinding): number {
  const scoreA = a.lift * a.confidence;
  const scoreB = b.lift * b.confidence;
  return scoreA - scoreB || b.sampleSize - a.sampleSize;
}
