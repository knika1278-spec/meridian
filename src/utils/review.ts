import chalk from "chalk";
import Table from "cli-table3";
import type { DecisionLogEntry, DecisionAction } from "../types/index.js";
import type { DecisionLogger } from "./decision-logger.js";
import { shortAddr } from "./formatter.js";

export interface ReviewOptions {
  limit?: number;
  actionFilter?: string;
  poolFilter?: string;
  showDetail?: boolean;
  json?: boolean;
}

interface ActionStat {
  count: number;
  pct: string;
  avgConfidence: string;
}

interface PoolStat {
  address: string;
  name: string;
  count: number;
  lastAction?: DecisionAction | undefined;
  lastConfidence?: number | undefined;
  lastTs: number;
}

interface PhraseFreq {
  text: string;
  count: number;
}

interface AggregatedStats {
  totalEntries: number;
  byAction: Record<string, ActionStat>;
  filtersPassedCount: number;
  filtersPassedPct: string;
  decisionCount: number;
  dryRunCount: number;
  liveCount: number;
  topPools: PoolStat[];
  topReasons: PhraseFreq[];
  topRisks: PhraseFreq[];
  timeRange?: {
    first: string;
    last: string;
    spanHours: string;
  };
}

const ACTION_ORDER: DecisionAction[] = ["ENTER", "WATCH", "SKIP"];

function actionBadge(action: string): string {
  switch (action.toUpperCase()) {
    case "ENTER":
      return chalk.bgGreen.black.bold(" ENTER ");
    case "WATCH":
      return chalk.bgYellow.black.bold(" WATCH ");
    case "SKIP":
      return chalk.bgRed.white.bold(" SKIP  ");
    default:
      return chalk.gray(` ${action} `);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}

function normalizePhrase(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 100);
}

function computeStats(entries: DecisionLogEntry[]): AggregatedStats {
  const total = entries.length;
  const actionAgg = new Map<string, { count: number; sumConf: number }>();
  let filtersPassedCount = 0;
  let decisionCount = 0;
  let dryRunCount = 0;
  let liveCount = 0;
  const poolMap = new Map<string, PoolStat>();
  const reasonMap = new Map<string, number>();
  const riskMap = new Map<string, number>();
  let firstTs = Infinity;
  let lastTs = -Infinity;

  for (const e of entries) {
    if (e.filtersPassed) filtersPassedCount++;
    if (e.dryRun) dryRunCount++;
    else liveCount++;
    if (e.timestamp < firstTs) firstTs = e.timestamp;
    if (e.timestamp > lastTs) lastTs = e.timestamp;

    const existing = poolMap.get(e.pool.address) ?? {
      address: e.pool.address,
      name: e.pool.name,
      count: 0,
      lastTs: 0,
    };
    existing.count++;
    if (e.timestamp > existing.lastTs) {
      existing.lastTs = e.timestamp;
      existing.lastAction = e.decision?.action;
      existing.lastConfidence = e.decision?.confidence;
    }
    poolMap.set(e.pool.address, existing);

    if (e.decision) {
      decisionCount++;
      const key = e.decision.action;
      const agg = actionAgg.get(key) ?? { count: 0, sumConf: 0 };
      agg.count++;
      agg.sumConf += e.decision.confidence;
      actionAgg.set(key, agg);

      for (const r of e.decision.reasons) {
        const k = normalizePhrase(r);
        reasonMap.set(k, (reasonMap.get(k) ?? 0) + 1);
      }
      for (const r of e.decision.risks) {
        const k = normalizePhrase(r);
        riskMap.set(k, (riskMap.get(k) ?? 0) + 1);
      }
    }
  }

  const byAction: Record<string, ActionStat> = {};
  for (const action of ACTION_ORDER) {
    const v = actionAgg.get(action);
    if (!v) continue;
    byAction[action] = {
      count: v.count,
      pct: total > 0 ? `${((v.count / total) * 100).toFixed(1)}%` : "—",
      avgConfidence:
        v.count > 0 ? `${((v.sumConf / v.count) * 100).toFixed(1)}%` : "—",
    };
  }

  const topPools = Array.from(poolMap.values()).sort(
    (a, b) => b.count - a.count,
  );
  const topReasons = Array.from(reasonMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([text, count]) => ({ text, count }));
  const topRisks = Array.from(riskMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([text, count]) => ({ text, count }));

  const result: AggregatedStats = {
    totalEntries: total,
    byAction,
    filtersPassedCount,
    filtersPassedPct:
      total > 0 ? `${((filtersPassedCount / total) * 100).toFixed(1)}%` : "—",
    decisionCount,
    dryRunCount,
    liveCount,
    topPools,
    topReasons,
    topRisks,
  };

  if (firstTs !== Infinity && lastTs !== -Infinity) {
    result.timeRange = {
      first: new Date(firstTs).toLocaleString(),
      last: new Date(lastTs).toLocaleString(),
      spanHours: ((lastTs - firstTs) / 3_600_000).toFixed(1),
    };
  }

  return result;
}

function renderEntry(entry: DecisionLogEntry): string {
  const lines: string[] = [];
  const ts = new Date(entry.timestamp).toLocaleString();
  const decision = entry.decision;

  lines.push("");
  lines.push(
    chalk.bold.cyan(
      `▶ ${entry.pool.name}  ${chalk.gray("(" + shortAddr(entry.pool.address) + ")")}`,
    ),
  );
  lines.push(
    chalk.gray(
      `  ${ts}  cycle=${entry.cycleId}  ${entry.dryRun ? chalk.yellow("[DRY-RUN]") : chalk.green("[LIVE]")}`,
    ),
  );
  lines.push(
    chalk.gray(`  filtersPassed: ${entry.filtersPassed ? "yes" : "no"}`),
  );

  if (!decision) {
    lines.push(chalk.gray("  (no LLM decision — likely filter failed)"));
    return lines.join("\n");
  }

  lines.push(
    `  Decision: ${actionBadge(decision.action)}  confidence=${(decision.confidence * 100).toFixed(0)}%`,
  );

  if (decision.reasons.length > 0) {
    lines.push(chalk.green("  Reasons:"));
    for (const r of decision.reasons) lines.push(`    + ${r}`);
  }
  if (decision.risks.length > 0) {
    lines.push(chalk.yellow("  Risks:"));
    for (const r of decision.risks) lines.push(`    - ${r}`);
  }
  if (decision.notes) {
    lines.push(chalk.gray(`  Notes: ${decision.notes}`));
  }
  if (
    decision.suggestedSizeUsd !== undefined &&
    decision.suggestedSizeUsd > 0
  ) {
    const range = decision.suggestedRangeBps
      ? `, range ±${decision.suggestedRangeBps} bps`
      : "";
    lines.push(
      chalk.gray(
        `  Suggested size: $${decision.suggestedSizeUsd.toFixed(0)}${range}`,
      ),
    );
  }
  return lines.join("\n");
}

export function reviewDecisions(
  decisionLogger: DecisionLogger,
  opts: ReviewOptions,
): void {
  let entries = decisionLogger.readAll();

  if (entries.length === 0) {
    console.log(chalk.yellow(`No decisions found at ${decisionLogger.path()}`));
    console.log(
      chalk.gray(
        "Run `npm run dev -- screen --limit 10` to generate decisions.",
      ),
    );
    return;
  }

  // Filters
  if (opts.actionFilter) {
    const want = opts.actionFilter.toUpperCase();
    entries = entries.filter((e) => e.decision?.action === want);
  }
  if (opts.poolFilter) {
    const q = opts.poolFilter.toLowerCase();
    entries = entries.filter((e) => e.pool.name.toLowerCase().includes(q));
  }

  if (entries.length === 0) {
    console.log(chalk.yellow(`No entries match the requested filters.`));
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  const stats = computeStats(entries);

  // --- Header ---
  console.log(chalk.bold.cyan("\nDecision Log Review"));
  console.log(chalk.gray(`File:    ${decisionLogger.path()}`));
  console.log(chalk.gray(`Entries: ${stats.totalEntries}`));
  if (stats.timeRange) {
    console.log(
      chalk.gray(
        `Range:   ${stats.timeRange.first}  →  ${stats.timeRange.last}  (${stats.timeRange.spanHours}h)`,
      ),
    );
  }

  // --- Funnel ---
  console.log(chalk.bold("\n=== Funnel ==="));
  console.log(
    `  Filters passed:    ${stats.filtersPassedCount} / ${stats.totalEntries}  (${stats.filtersPassedPct})`,
  );
  console.log(
    `  LLM decisions made: ${stats.decisionCount} / ${stats.totalEntries}`,
  );
  console.log(
    `  Mode:               ${chalk.yellow("dry-run")} ${stats.dryRunCount}  ${chalk.green("live")} ${stats.liveCount}`,
  );

  // --- Action distribution ---
  const distActions = Object.keys(stats.byAction);
  if (distActions.length > 0) {
    console.log(chalk.bold("\n=== Action Distribution ==="));
    const distTable = new Table({
      head: [
        chalk.cyan("Action"),
        chalk.cyan("Count"),
        chalk.cyan("% of total"),
        chalk.cyan("Avg confidence"),
      ],
      colWidths: [12, 8, 14, 18],
    });
    for (const action of distActions) {
      const v = stats.byAction[action]!;
      distTable.push([
        actionBadge(action),
        String(v.count),
        v.pct,
        v.avgConfidence,
      ]);
    }
    console.log(distTable.toString());
  }

  // --- Top pools ---
  if (stats.topPools.length > 0) {
    console.log(chalk.bold("\n=== Most-Evaluated Pools ==="));
    const poolsTable = new Table({
      head: [
        chalk.cyan("Pool"),
        chalk.cyan("Evals"),
        chalk.cyan("Last action"),
        chalk.cyan("Last conf"),
      ],
      colWidths: [22, 8, 14, 12],
    });
    for (const p of stats.topPools.slice(0, 10)) {
      poolsTable.push([
        `${chalk.bold(p.name)}\n${chalk.gray(shortAddr(p.address))}`,
        String(p.count),
        p.lastAction ? actionBadge(p.lastAction) : chalk.gray("—"),
        p.lastConfidence !== undefined
          ? `${(p.lastConfidence * 100).toFixed(0)}%`
          : chalk.gray("—"),
      ]);
    }
    console.log(poolsTable.toString());
  }

  // --- Top reasons / risks ---
  if (stats.topReasons.length > 0) {
    console.log(chalk.bold("\n=== Top Cited Reasons ==="));
    for (const r of stats.topReasons.slice(0, 5)) {
      console.log(`  ${chalk.green(`(${r.count}×)`)}  ${truncate(r.text, 90)}`);
    }
  }
  if (stats.topRisks.length > 0) {
    console.log(chalk.bold("\n=== Top Cited Risks ==="));
    for (const r of stats.topRisks.slice(0, 5)) {
      console.log(
        `  ${chalk.yellow(`(${r.count}×)`)}  ${truncate(r.text, 90)}`,
      );
    }
  }

  // --- Detailed last N ---
  if (opts.showDetail !== false) {
    const n = Math.max(1, opts.limit ?? 5);
    const recent = entries.slice(-n);
    console.log(
      chalk.bold(`\n=== Last ${recent.length} Decision(s) (detail) ===`),
    );
    for (const entry of recent) {
      console.log(renderEntry(entry));
    }
  }
}
