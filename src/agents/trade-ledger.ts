import fs from "node:fs";
import path from "node:path";
import { childLogger } from "../utils/logger.js";

const log = childLogger("trade-ledger");

export interface TradeOpenRecord {
  type: "open";
  /** Unix ms. */
  timestamp: number;
  poolAddress: string;
  poolName: string;
  /** USD deployed into the position at open. */
  sizeUsd: number;
  positionPubkey?: string;
}

export interface TradeCloseRecord {
  type: "close";
  /** Unix ms. */
  timestamp: number;
  poolAddress: string;
  poolName: string;
  /** Entry/notional USD of the closed position. */
  sizeUsd: number;
  /** Realized PnL in USD (negative = loss). */
  pnlUsd: number;
  pnlPct?: number;
  exitReason?: string;
  ageMinutes?: number;
  positionPubkey?: string;
}

export type TradeRecord = TradeOpenRecord | TradeCloseRecord;

export interface TradeLedgerOptions {
  filePath: string;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export interface RecordOpenInput {
  poolAddress: string;
  poolName: string;
  sizeUsd: number;
  positionPubkey?: string;
  timestamp?: number;
}

export interface RecordCloseInput {
  poolAddress: string;
  poolName: string;
  sizeUsd: number;
  pnlUsd: number;
  pnlPct?: number;
  exitReason?: string;
  ageMinutes?: number;
  positionPubkey?: string;
  timestamp?: number;
}

/** UTC calendar-day key (YYYY-MM-DD) for a Unix-ms timestamp. */
function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Append-only ledger of real (non-dry-run) trades, persisted as JSONL to
 * `data/trade-log.jsonl`. Backs the Phase 4 daily-spend / daily-loss / drawdown
 * safety limits. Only LIVE trades should be recorded here; paper/dry-run
 * positions must never reach this ledger.
 */
export class TradeLedger {
  private readonly filePath: string;
  private readonly now: () => number;
  private records: TradeRecord[];

  constructor(opts: TradeLedgerOptions) {
    this.filePath = path.resolve(opts.filePath);
    this.now = opts.now ?? (() => Date.now());
    this.ensureFile();
    this.records = this.readFromDisk();
  }

  recordOpen(input: RecordOpenInput): void {
    const record: TradeOpenRecord = {
      type: "open",
      timestamp: input.timestamp ?? this.now(),
      poolAddress: input.poolAddress,
      poolName: input.poolName,
      sizeUsd: input.sizeUsd,
      ...(input.positionPubkey ? { positionPubkey: input.positionPubkey } : {}),
    };
    this.append(record);
  }

  recordClose(input: RecordCloseInput): void {
    const record: TradeCloseRecord = {
      type: "close",
      timestamp: input.timestamp ?? this.now(),
      poolAddress: input.poolAddress,
      poolName: input.poolName,
      sizeUsd: input.sizeUsd,
      pnlUsd: input.pnlUsd,
      ...(input.pnlPct !== undefined ? { pnlPct: input.pnlPct } : {}),
      ...(input.exitReason ? { exitReason: input.exitReason } : {}),
      ...(input.ageMinutes !== undefined
        ? { ageMinutes: input.ageMinutes }
        : {}),
      ...(input.positionPubkey ? { positionPubkey: input.positionPubkey } : {}),
    };
    this.append(record);
  }

  /** Sum of `sizeUsd` for live opens within the UTC day containing `at`. */
  getDailySpendUsd(at: number = this.now()): number {
    const key = utcDayKey(at);
    return this.records
      .filter((r) => r.type === "open" && utcDayKey(r.timestamp) === key)
      .reduce((sum, r) => sum + r.sizeUsd, 0);
  }

  /** Count of live opens within the UTC day containing `at`. */
  getDailyTradeCount(at: number = this.now()): number {
    const key = utcDayKey(at);
    return this.records.filter(
      (r) => r.type === "open" && utcDayKey(r.timestamp) === key,
    ).length;
  }

  /** Sum of realized PnL for live closes within the UTC day containing `at`. */
  getDailyRealizedPnlUsd(at: number = this.now()): number {
    const key = utcDayKey(at);
    return this.records
      .filter(
        (r): r is TradeCloseRecord =>
          r.type === "close" && utcDayKey(r.timestamp) === key,
      )
      .reduce((sum, r) => sum + r.pnlUsd, 0);
  }

  /** Sum of realized PnL across all live closes ever recorded. */
  getCumulativeRealizedPnlUsd(): number {
    return this.records
      .filter((r): r is TradeCloseRecord => r.type === "close")
      .reduce((sum, r) => sum + r.pnlUsd, 0);
  }

  /**
   * Equity drawdown from peak as a fraction (0..1), where
   * equity(t) = startingCapitalUsd + cumulative realized PnL up to t.
   * Returns 0 when current equity is at or above the running peak.
   */
  getDrawdownPct(startingCapitalUsd: number): number {
    const closes = this.records
      .filter((r): r is TradeCloseRecord => r.type === "close")
      .sort((a, b) => a.timestamp - b.timestamp);
    let equity = startingCapitalUsd;
    let peak = startingCapitalUsd;
    for (const close of closes) {
      equity += close.pnlUsd;
      if (equity > peak) peak = equity;
    }
    if (peak <= 0) return 0;
    return Math.max(0, (peak - equity) / peak);
  }

  path(): string {
    return this.filePath;
  }

  private append(record: TradeRecord): void {
    this.records.push(record);
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "failed to append trade-log record",
      );
    }
  }

  private ensureFile(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, "", "utf-8");
      }
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "failed to ensure trade-log file",
      );
    }
  }

  private readFromDisk(): TradeRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "unreadable trade-log file, treating as empty",
      );
      return [];
    }
    const records: TradeRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as TradeRecord);
      } catch {
        log.warn(
          { line: trimmed.slice(0, 120) },
          "skipping corrupt trade-log line",
        );
      }
    }
    return records;
  }
}
