import type { SafetyConfig } from "../types/index.js";

/**
 * Read-only snapshot of everything the safety gate needs to decide whether a
 * single live position open is permitted. The caller (manager.open) assembles
 * this from the trade ledger + circuit breaker before deploying capital.
 */
export interface SafetySnapshot {
  /** USD size of the candidate open being evaluated. */
  tradeSizeUsd: number;
  /** USD already deployed via live opens in the current UTC day. */
  dailySpendUsd: number;
  /** Live opens already executed in the current UTC day. */
  dailyTradeCount: number;
  /** Realized PnL (USD) summed over live closes in the current UTC day. */
  dailyRealizedPnlUsd: number;
  /** Equity drawdown from peak as a fraction (0..1); 0 when at/above peak. */
  drawdownPct: number;
  /** True when the trading circuit breaker is currently halted. */
  circuitHalted: boolean;
  /** Reason the breaker halted, if halted. */
  circuitHaltReason?: string | null;
}

export type SafetyBlockCode =
  | "circuit_halted"
  | "max_single_trade"
  | "max_daily_trades"
  | "max_daily_spend"
  | "max_daily_loss"
  | "max_drawdown";

export interface SafetyDecision {
  ok: boolean;
  code?: SafetyBlockCode;
  reason?: string;
}

/**
 * Pure, side-effect-free evaluation of the Phase 4 live-trading safety limits.
 * Returns `{ ok: true }` to permit the open, or `{ ok: false, code, reason }`
 * to block it. Order is intentional: the circuit-breaker halt and per-trade cap
 * are checked before the cumulative daily/drawdown limits.
 */
export function evaluateSafety(
  cfg: SafetyConfig,
  snapshot: SafetySnapshot,
): SafetyDecision {
  if (!cfg.enabled) return { ok: true };

  if (snapshot.circuitHalted) {
    return {
      ok: false,
      code: "circuit_halted",
      reason: `circuit breaker halted${
        snapshot.circuitHaltReason ? `: ${snapshot.circuitHaltReason}` : ""
      }`,
    };
  }

  if (snapshot.tradeSizeUsd > cfg.maxSingleTradeUsd) {
    return {
      ok: false,
      code: "max_single_trade",
      reason: `trade $${money(snapshot.tradeSizeUsd)} exceeds maxSingleTradeUsd $${money(
        cfg.maxSingleTradeUsd,
      )}`,
    };
  }

  if (cfg.maxDailyTrades !== undefined && snapshot.dailyTradeCount >= cfg.maxDailyTrades) {
    return {
      ok: false,
      code: "max_daily_trades",
      reason: `daily trade count ${snapshot.dailyTradeCount} reached maxDailyTrades ${cfg.maxDailyTrades}`,
    };
  }

  if (cfg.maxDailySpendUsd !== undefined && snapshot.dailySpendUsd + snapshot.tradeSizeUsd > cfg.maxDailySpendUsd) {
    return {
      ok: false,
      code: "max_daily_spend",
      reason: `daily spend $${money(snapshot.dailySpendUsd)} + $${money(
        snapshot.tradeSizeUsd,
      )} would exceed maxDailySpendUsd $${money(cfg.maxDailySpendUsd)}`,
    };
  }

  if (snapshot.dailyRealizedPnlUsd <= -cfg.maxDailyLossUsd) {
    return {
      ok: false,
      code: "max_daily_loss",
      reason: `daily realized loss $${money(
        -snapshot.dailyRealizedPnlUsd,
      )} reached maxDailyLossUsd $${money(cfg.maxDailyLossUsd)} — halting new opens`,
    };
  }

  if (snapshot.drawdownPct > cfg.maxTotalDrawdownPct) {
    return {
      ok: false,
      code: "max_drawdown",
      reason: `drawdown ${(snapshot.drawdownPct * 100).toFixed(
        1,
      )}% exceeds maxTotalDrawdownPct ${(cfg.maxTotalDrawdownPct * 100).toFixed(
        1,
      )}% — halting new opens`,
    };
  }

  return { ok: true };
}

function money(n: number): string {
  return n.toFixed(2);
}
