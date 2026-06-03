#!/usr/bin/env tsx
// Read-only confidence calibration analysis.
// Joins learning-decisions.jsonl × learning-outcomes.jsonl on decisionId.
// Reports: Pearson correlation + calibration table by confidence bin × horizon.
// Usage:  npm run learning:calibrate
// No files are modified — safe to run at any time.

import fs from "node:fs";
import readline from "node:readline";
import type { LearningDecision, LearningOutcome } from "../types/index.js";

const DECISIONS_FILE = "./data/learning-decisions.jsonl";
const OUTCOMES_FILE = "./data/learning-outcomes.jsonl";

const BINS = [0, 0.2, 0.4, 0.6, 0.8, 1.01];
const BIN_LABELS = ["0.0–0.2", "0.2–0.4", "0.4–0.6", "0.6–0.8", "0.8–1.0"];

async function readJsonl<T>(file: string): Promise<T[]> {
  if (!fs.existsSync(file)) return [];
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  const rows: T[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? NaN : num / denom;
}

function fmt(n: number): string {
  return isNaN(n) ? "  n/a  " : n.toFixed(4);
}

async function main(): Promise<void> {
  const decisions = await readJsonl<LearningDecision>(DECISIONS_FILE);
  const outcomes = await readJsonl<LearningOutcome>(OUTCOMES_FILE);

  const confMap = new Map<string, number>();
  for (const d of decisions) {
    if (typeof d.confidence === "number" && Number.isFinite(d.confidence)) {
      confMap.set(d.id, d.confidence);
    }
  }

  type Row = { confidence: number; score: number; horizonMinutes: number };
  const rows: Row[] = [];
  for (const o of outcomes) {
    const conf = confMap.get(o.decisionId);
    if (conf === undefined) continue;
    rows.push({
      confidence: conf,
      score: o.netPnlRiskScore,
      horizonMinutes: o.horizonMinutes,
    });
  }

  if (rows.length === 0) {
    console.log(
      "No joined rows — ensure decisions and outcomes share decisionIds, " +
        "and that confidence is present on decisions.",
    );
    return;
  }

  console.log("\n=== Confidence Calibration Report ===");
  console.log(`Joined ${rows.length} decision-outcome pairs\n`);

  // Overall Pearson correlation.
  const r = pearson(
    rows.map((row) => row.confidence),
    rows.map((row) => row.score),
  );
  console.log(`Overall Pearson(confidence, netPnlRiskScore) = ${fmt(r)}`);
  console.log(
    r > 0.2
      ? "  → Moderate positive correlation: higher confidence tends toward better outcomes."
      : r < -0.1
        ? "  → Negative correlation: confidence is anti-correlated with outcomes."
        : "  → Weak/no correlation: confidence is not predictive of outcomes.",
  );

  // Per-horizon correlation.
  const horizons = [...new Set(rows.map((row) => row.horizonMinutes))].sort(
    (a, b) => a - b,
  );
  console.log("\nPer-horizon Pearson correlation:");
  for (const h of horizons) {
    const hr = rows.filter((row) => row.horizonMinutes === h);
    const rh = pearson(
      hr.map((x) => x.confidence),
      hr.map((x) => x.score),
    );
    console.log(
      `  h=${String(h).padEnd(4)}min  n=${String(hr.length).padEnd(5)}  r=${fmt(rh)}`,
    );
  }

  // Calibration table: confidence bins × horizons.
  const colWidth = 12;
  console.log(
    "\nCalibration table — mean(score) per confidence bin × horizon:",
  );
  const header = [
    "Bin".padEnd(9),
    ...horizons.map((h) => `h=${h}m`.padStart(colWidth)),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (let b = 0; b < BIN_LABELS.length; b++) {
    const lo = BINS[b] ?? 0;
    const hi = BINS[b + 1] ?? 1.01;
    const cells: string[] = [(BIN_LABELS[b] ?? "").padEnd(9)];
    for (const h of horizons) {
      const subset = rows.filter(
        (row) =>
          row.confidence >= lo &&
          row.confidence < hi &&
          row.horizonMinutes === h,
      );
      if (subset.length === 0) {
        cells.push("n/a".padStart(colWidth));
        continue;
      }
      const mean = subset.reduce((a, row) => a + row.score, 0) / subset.length;
      cells.push(`${mean.toFixed(3)}(n=${subset.length})`.padStart(colWidth));
    }
    console.log(cells.join("  "));
  }

  console.log("\n[No files modified — read-only analysis]");
}

main().catch((err) => {
  console.error("calibrate-confidence failed:", err);
  process.exit(1);
});
