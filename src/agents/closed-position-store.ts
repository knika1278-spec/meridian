import fs from "node:fs";
import path from "node:path";
import type { ClosedPosition } from "../types/index.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("closed-position-store");

export interface ClosedPositionStoreOptions {
  filePath: string;
  /**
   * Optional hook fired after a close is persisted. Used to forward realized
   * outcomes to the trade ledger / circuit breaker. Failures here never break
   * the store; the hook's own errors are caught and logged.
   */
  onClose?: (entry: ClosedPosition) => void;
}

export class ClosedPositionStore {
  private readonly filePath: string;
  private readonly onClose?: (entry: ClosedPosition) => void;
  private entries: ClosedPosition[];

  constructor(opts: ClosedPositionStoreOptions) {
    this.filePath = path.resolve(opts.filePath);
    if (opts.onClose) this.onClose = opts.onClose;
    this.ensureFile();
    this.entries = this.readFromDisk();
  }

  add(entry: ClosedPosition): void {
    this.entries.push(entry);
    this.flush();
    if (this.onClose) {
      try {
        this.onClose(entry);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "closed-position onClose hook failed",
        );
      }
    }
  }

  /** Most-recent-first. */
  list(limit?: number): ClosedPosition[] {
    const sorted = [...this.entries].sort((a, b) => b.closedAt - a.closedAt);
    if (limit === undefined) return sorted;
    return sorted.slice(0, Math.max(0, limit));
  }

  count(): number {
    return this.entries.length;
  }

  path(): string {
    return this.filePath;
  }

  private ensureFile(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, "[]", "utf-8");
      }
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "failed to ensure closed positions file",
      );
    }
  }

  private readFromDisk(): ClosedPosition[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        log.warn(
          { path: this.filePath },
          "closed positions file not array, resetting",
        );
        return [];
      }
      return parsed as ClosedPosition[];
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "corrupt or unreadable closed positions file, treating as empty",
      );
      return [];
    }
  }

  private flush(): void {
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.entries, null, 2),
        "utf-8",
      );
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "failed to write closed positions file",
      );
    }
  }
}
