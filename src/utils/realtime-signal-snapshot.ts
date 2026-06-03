import fs from "node:fs";
import path from "node:path";
import type { RealtimeEvent } from "../types/index.js";
import { childLogger } from "./logger.js";

const log = childLogger("realtime-signal-snapshot");

export interface RealtimeSignalSnapshotStoreOptions {
  filePath: string;
  maxEvents?: number;
  flushIntervalMs?: number;
}

export class RealtimeSignalSnapshotStore {
  private readonly filePath: string;
  private readonly maxEvents: number;
  private readonly flushIntervalMs: number;
  private readonly events: RealtimeEvent[] = [];
  private lastFlushAt = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(opts: RealtimeSignalSnapshotStoreOptions) {
    this.filePath = path.resolve(opts.filePath);
    this.maxEvents = opts.maxEvents ?? 500;
    this.flushIntervalMs = opts.flushIntervalMs ?? 1_000;
    this.ensureFile();
  }

  record(event: RealtimeEvent): void {
    if (event.kind === "unknown" || !event.poolAddress) return;
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    const now = Date.now();
    if (now - this.lastFlushAt >= this.flushIntervalMs) {
      this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  flush(): void {
    this.lastFlushAt = Date.now();
    const payload = {
      ts: this.lastFlushAt,
      maxEvents: this.maxEvents,
      events: this.events.slice(-this.maxEvents),
    };
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "failed to write realtime signal snapshot",
      );
    }
  }

  path(): string {
    return this.filePath;
  }

  private ensureFile(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(
          this.filePath,
          JSON.stringify(
            { ts: Date.now(), maxEvents: this.maxEvents, events: [] },
            null,
            2,
          ),
          "utf-8",
        );
      }
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "failed to ensure realtime signal snapshot",
      );
    }
  }
}
