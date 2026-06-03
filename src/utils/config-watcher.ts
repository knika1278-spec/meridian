import fs, { type FSWatcher } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { childLogger, type Logger } from "../utils/logger.js";
import type { UserConfig } from "../types/index.js";

export interface ConfigWatcherOptions {
  configPath: string;
  onReload: (next: UserConfig, prev: UserConfig) => void;
  /** Debounce burst writes (ms). Default 500. */
  debounceMs?: number;
}

/**
 * Watches a `user-config.json` file for changes. On every successful reload
 * (file readable + Zod-valid + content actually changed) invokes `onReload`
 * with the previous and next snapshots.
 *
 * Failures (Zod errors, IO errors) are logged and swallowed — the watcher
 * must never crash the bot loop.
 */
export class ConfigWatcher {
  private readonly filePath: string;
  private readonly onReload: (next: UserConfig, prev: UserConfig) => void;
  private readonly debounceMs: number;
  private readonly log: Logger;

  private watcher: FSWatcher | null = null;
  private debounceHandle: NodeJS.Timeout | null = null;
  private current: UserConfig | null = null;
  private started = false;

  constructor(opts: ConfigWatcherOptions) {
    this.filePath = path.resolve(opts.configPath);
    this.onReload = opts.onReload;
    this.debounceMs = opts.debounceMs ?? 500;
    this.log = childLogger("config-watcher");
  }

  start(): void {
    if (this.started) {
      this.log.warn("start called but watcher already running");
      return;
    }
    // Seed current state so reload comparisons make sense.
    try {
      this.current = loadConfig(this.filePath);
    } catch (err) {
      this.log.warn(
        { err: errMessage(err), file: this.filePath },
        "initial config load failed; watcher will retry on file change",
      );
    }

    try {
      this.watcher = fs.watch(this.filePath, () => {
        this.scheduleReload();
      });
      this.watcher.on("error", (err: unknown) => {
        this.log.warn(
          { err: errMessage(err), file: this.filePath },
          "fs.watch error",
        );
      });
      this.started = true;
      this.log.info({ file: this.filePath }, "config watcher started");
    } catch (err) {
      this.log.error(
        { err: errMessage(err), file: this.filePath },
        "failed to install fs.watch; hot-reload disabled",
      );
    }
  }

  stop(): void {
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch (err) {
        this.log.warn({ err: errMessage(err) }, "watcher.close threw");
      }
      this.watcher = null;
    }
    this.started = false;
    this.log.info("config watcher stopped");
  }

  // ---------- internals ----------

  private scheduleReload(): void {
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = null;
      this.reload();
    }, this.debounceMs);
  }

  private reload(): void {
    let next: UserConfig;
    try {
      next = loadConfig(this.filePath);
    } catch (err) {
      this.log.warn(
        { err: errMessage(err), file: this.filePath },
        "config reload failed; keeping previous in-memory snapshot",
      );
      return;
    }

    const prev = this.current;
    if (prev && deepEqual(prev, next)) {
      this.log.debug("config reloaded but no fields changed; skipping");
      return;
    }
    const changedKeys = prev ? topLevelDiff(prev, next) : Object.keys(next);
    this.current = next;
    this.log.info({ changedKeys, file: this.filePath }, "config reloaded");
    try {
      this.onReload(next, prev ?? next);
    } catch (err) {
      this.log.warn(
        { err: errMessage(err) },
        "onReload handler threw; swallowing to keep loop alive",
      );
    }
  }
}

// ---------- shared helpers ----------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function topLevelDiff(
  prev: Record<string, unknown> | UserConfig,
  next: Record<string, unknown> | UserConfig,
): string[] {
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const keys = new Set<string>([...Object.keys(p), ...Object.keys(n)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (!deepEqual(p[k], n[k])) changed.push(k);
  }
  return changed;
}

export const __internal = { deepEqual, topLevelDiff };
