import chalk from "chalk";
import Table from "cli-table3";
import type { LLMDecision, ScreeningResult } from "../types/index.js";

export function fmtUsd(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

export function fmtPct(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(2)}%`;
}

export function fmtNum(n: number | undefined | null, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toFixed(digits);
}

export function shortAddr(addr: string | undefined | null): string {
  if (!addr) return "-";
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function decisionBadge(action: LLMDecision["action"]): string {
  switch (action) {
    case "ENTER":
      return chalk.bgGreen.black.bold(" ENTER ");
    case "WATCH":
      return chalk.bgYellow.black.bold(" WATCH ");
    case "SKIP":
      return chalk.bgRed.white.bold(" SKIP  ");
  }
}

export function renderResultsTable(results: ScreeningResult[]): string {
  const table = new Table({
    head: [
      chalk.cyan("Pool"),
      chalk.cyan("Bin"),
      chalk.cyan("TVL"),
      chalk.cyan("Vol"),
      chalk.cyan("Fees"),
      chalk.cyan("Fee/aTVL"),
      chalk.cyan("Filters"),
      chalk.cyan("Decision"),
    ],
    colWidths: [22, 6, 10, 10, 10, 10, 9, 13],
    wordWrap: true,
  });

  for (const r of results) {
    const p = r.pool;
    const feeTvl = p.activeTvl > 0 ? p.fees24h / p.activeTvl : 0;
    table.push([
      `${chalk.bold(p.name)}\n${chalk.gray(shortAddr(p.address))}`,
      String(p.binStep),
      fmtUsd(p.tvl),
      fmtUsd(p.volume24h),
      fmtUsd(p.fees24h),
      fmtPct(feeTvl),
      r.filtersPassed ? chalk.green("PASS") : chalk.red("FAIL"),
      r.decision ? decisionBadge(r.decision.action) : chalk.gray("—"),
    ]);
  }

  return table.toString();
}

function renderTokenSignals(r: ScreeningResult): string | undefined {
  const parts: string[] = [];
  for (const t of [r.pool.tokenX, r.pool.tokenY]) {
    const seg: string[] = [];
    if (t.risk?.riskScore !== undefined) {
      const score = t.risk.riskScore;
      const color =
        score >= 70 ? chalk.red : score >= 40 ? chalk.yellow : chalk.green;
      seg.push(`risk=${color(score.toFixed(0))}`);
    }
    if (t.smartMoney?.netFlowUsd !== undefined) {
      const v = t.smartMoney.netFlowUsd;
      const txt = (v >= 0 ? "+" : "") + fmtUsd(v);
      seg.push(`smart=${v >= 0 ? chalk.green(txt) : chalk.red(txt)}`);
    }
    if (t.audit?.mintAuthorityDisabled === false) {
      seg.push(chalk.red("mint!"));
    }
    if (t.audit?.freezeAuthorityDisabled === false) {
      seg.push(chalk.red("freeze!"));
    }
    if (t.launchpad?.launchpad) {
      seg.push(chalk.magenta(`lp=${t.launchpad.launchpad}`));
    }
    if (seg.length > 0) parts.push(`${t.symbol}: ${seg.join(" ")}`);
  }
  if (parts.length === 0) return undefined;
  return chalk.gray(`  Signals → ${parts.join("  |  ")}`);
}

export function renderDecisionDetail(r: ScreeningResult): string {
  const lines: string[] = [];
  lines.push(
    chalk.bold.cyan(
      `\n▶ ${r.pool.name}  ${chalk.gray("(" + shortAddr(r.pool.address) + ")")}`,
    ),
  );
  lines.push(
    `  Bin Step: ${r.pool.binStep}   TVL: ${fmtUsd(r.pool.tvl)}   ActiveTVL: ${fmtUsd(r.pool.activeTvl)}`,
  );
  lines.push(
    `  Window Volume: ${fmtUsd(r.pool.volume24h)}   Window Fees: ${fmtUsd(r.pool.fees24h)}`,
  );
  const sigLine = renderTokenSignals(r);
  if (sigLine) lines.push(sigLine);
  if (r.realtimeSignals.length > 0) {
    lines.push(
      chalk.gray(
        `  Realtime signals (last ${r.realtimeSignals.length}): ` +
          r.realtimeSignals
            .slice(-5)
            .map((s) => s.kind)
            .join(", "),
      ),
    );
  }
  if (r.decision) {
    lines.push(
      `  Decision: ${decisionBadge(r.decision.action)}  confidence=${fmtPct(r.decision.confidence)}`,
    );
    if (r.decision.reasons.length > 0) {
      lines.push(chalk.green("  Reasons:"));
      for (const reason of r.decision.reasons) lines.push(`    + ${reason}`);
    }
    if (r.decision.risks.length > 0) {
      lines.push(chalk.yellow("  Risks:"));
      for (const risk of r.decision.risks) lines.push(`    - ${risk}`);
    }
    if (r.decision.suggestedSizeUsd && r.decision.suggestedSizeUsd > 0) {
      lines.push(
        chalk.gray(
          `  Suggested size: ${fmtUsd(r.decision.suggestedSizeUsd)}` +
            (r.decision.suggestedRangeBps
              ? `, range ±${r.decision.suggestedRangeBps} bps`
              : ""),
        ),
      );
    }
    if (r.decision.notes)
      lines.push(chalk.gray(`  Notes: ${r.decision.notes}`));
  }
  return lines.join("\n");
}
