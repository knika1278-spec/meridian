import fs from "node:fs";
import path from "node:path";
import { childLogger } from "../utils/logger.js";

const log = childLogger("circuit-breaker");

export interface CircuitBreakerState {
  /** Consecutive losing closes since the last win or reset. */
  consecutiveLosses: number;
  /** When true, no new live opens are permitted until reset(). */
  halted: boolean;
  haltReason: string | null;
  /** Unix ms when the halt was tripped. */
  haltedAt: number | null;
  /** Unix ms of the last state mutation. */
  updatedAt: number;
}

export interface CircuitBreakerOptions {
  filePath: string;
  /** Consecutive losses that trip the breaker into a halt. */
  maxConsecutiveLosses: number;
  /** Milliseconds after which a halted breaker auto-resets. Default: 24h. */
  resetAfterMs?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Optional callback fired once when the breaker transitions into a halt. */
  onHalt?: (reason: string) => void;
}

function freshState(now: number): CircuitBreakerState {
  return {
    consecutiveLosses: 0,
    halted: false,
    haltReason: null,
    haltedAt: null,
    updatedAt: now,
  };
}

/**
 * Persisted circuit breaker for live trading. Trips after N consecutive losing
 * closes and auto-resets after `resetAfterMs` (default 24h). State is written
 * to `data/circuit-breaker.json` so a process restart never silently un-halts:
 * a tripped breaker survives crashes and redeploys.
 */
const DEFAULT_RESET_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

export class TradingCircuitBreaker {
  private readonly filePath: string;
  private readonly maxConsecutiveLosses: number;
  private readonly resetAfterMs: number;
  private readonly now: () => number;
  private readonly onHalt?: (reason: string) => void;
  private state: CircuitBreakerState;

  constructor(opts: CircuitBreakerOptions) {
    this.filePath = path.resolve(opts.filePath);
    this.maxConsecutiveLosses = opts.maxConsecutiveLosses;
    this.resetAfterMs = opts.resetAfterMs ?? DEFAULT_RESET_AFTER_MS;
    this.now = opts.now ?? (() => Date.now());
    if (opts.onHalt) this.onHalt = opts.onHalt;
    this.ensureDir();
    this.state = this.readFromDisk() ?? freshState(this.now());
  }

  /** Record a realized trade outcome. Loss increments the streak; win resets it. */
  recordTrade(pnlUsd: number): void {
    if (pnlUsd < 0) {
      const consecutiveLosses = this.state.consecutiveLosses + 1;
      this.state = {
        ...this.state,
        consecutiveLosses,
        updatedAt: this.now(),
      };
      if (
        !this.state.halted &&
        consecutiveLosses >= this.maxConsecutiveLosses
      ) {
        this.halt(`${consecutiveLosses} consecutive losing trades`);
        return;
      }
    } else {
      this.state = {
        ...this.state,
        consecutiveLosses: 0,
        updatedAt: this.now(),
      };
    }
    this.flush();
  }

  /** True when new live opens are permitted. Auto-resets after resetAfterMs. */
  canTrade(): boolean {
    if (!this.state.halted) return true;

    // Auto-reset if halt has lasted longer than resetAfterMs
    const haltAge = this.now() - (this.state.haltedAt ?? 0);
    if (haltAge >= this.resetAfterMs) {
      log.warn(
        { haltAgeMs: haltAge, resetAfterMs: this.resetAfterMs },
        "circuit breaker halt expired — auto-resetting",
      );
      this.reset();
      return true;
    }

    return false;
  }

  /** Trip the breaker. Idempotent: re-halting keeps the original reason/time. */
  halt(reason: string): void {
    if (this.state.halted) return;
    const now = this.now();
    this.state = {
      ...this.state,
      halted: true,
      haltReason: reason,
      haltedAt: now,
      updatedAt: now,
    };
    this.flush();
    log.error(
      { reason },
      "circuit breaker tripped — refusing new live opens until reset",
    );
    this.onHalt?.(reason);
  }

  /** Clear a halt and the loss streak. Resumes live opens. */
  reset(): void {
    this.state = freshState(this.now());
    this.flush();
    log.warn("circuit breaker reset — live opens resumed");
  }

  status(): CircuitBreakerState {
    return { ...this.state };
  }

  private ensureDir(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "failed to ensure circuit-breaker directory",
      );
    }
  }

  private flush(): void {
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.state, null, 2),
        "utf-8",
      );
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "failed to persist circuit-breaker state",
      );
    }
  }

  private readFromDisk(): CircuitBreakerState | null {
    if (!fs.existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf-8"),
      ) as Partial<CircuitBreakerState>;
      return {
        consecutiveLosses:
          typeof parsed.consecutiveLosses === "number"
            ? parsed.consecutiveLosses
            : 0,
        halted: parsed.halted === true,
        haltReason:
          typeof parsed.haltReason === "string" ? parsed.haltReason : null,
        haltedAt: typeof parsed.haltedAt === "number" ? parsed.haltedAt : null,
        updatedAt:
          typeof parsed.updatedAt === "number" ? parsed.updatedAt : this.now(),
      };
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "corrupt circuit-breaker file — starting from fresh (un-halted) state",
      );
      return null;
    }
  }
}
