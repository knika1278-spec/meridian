import fs from "node:fs";
import path from "node:path";
import type { PoolMemoryEntry } from "../types/index.js";
import { logger } from "../utils/logger.js";

const DEFAULT_FILE = "./data/pool-memory.json";
const DEFAULT_COOLDOWN_HOURS = 24;

export class PoolMemoryStore {
  private readonly file: string;
  private readonly cooldownHours: number;
  private entries: Map<string, PoolMemoryEntry> = new Map();
  private loaded = false;

  constructor(file?: string, cooldownHours?: number) {
    this.file = file ?? DEFAULT_FILE;
    this.cooldownHours = cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
  }

  private ensureDir(): void {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  load(): void {
    this.ensureDir();
    if (!fs.existsSync(this.file)) {
      this.entries = new Map();
      this.loaded = true;
      return;
    }
    try {
      const raw = fs.readFileSync(this.file, "utf-8");
      const arr = JSON.parse(raw) as PoolMemoryEntry[];
      this.entries = new Map(arr.map((e) => [e.poolAddress, e]));
      logger.debug(
        { count: this.entries.size, file: this.file },
        "pool-memory-store: loaded",
      );
    } catch (err) {
      logger.error(
        { err, file: this.file },
        "pool-memory-store: failed to load — starting empty",
      );
      this.entries = new Map();
    }
    this.loaded = true;
  }

  private save(): void {
    this.ensureDir();
    const arr = [...this.entries.values()].sort(
      (a, b) => b.lastClosedAt - a.lastClosedAt,
    );
    try {
      fs.writeFileSync(this.file, JSON.stringify(arr, null, 2), "utf-8");
    } catch (err) {
      logger.error(
        { err, file: this.file },
        "pool-memory-store: failed to save",
      );
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load();
  }

  /** Returns true if the pool is in cooldown (should be blocked from re-entry). */
  isOnCooldown(poolAddress: string): boolean {
    this.ensureLoaded();
    const entry = this.entries.get(poolAddress);
    if (!entry) return false;
    return Date.now() < entry.cooldownUntil;
  }

  /** Returns cooldown expiry timestamp or 0 if not in cooldown. */
  cooldownExpiry(poolAddress: string): number {
    this.ensureLoaded();
    return this.entries.get(poolAddress)?.cooldownUntil ?? 0;
  }

  list(): PoolMemoryEntry[] {
    this.ensureLoaded();
    return [...this.entries.values()].sort(
      (a, b) => b.lastClosedAt - a.lastClosedAt,
    );
  }

  get(poolAddress: string): PoolMemoryEntry | undefined {
    this.ensureLoaded();
    return this.entries.get(poolAddress);
  }

  /**
   * Record a pool close event and start the cooldown timer.
   * Uses the configured cooldownHours; caller may override per-close.
   */
  record(
    params: Omit<PoolMemoryEntry, "lastClosedAt" | "cooldownUntil"> & {
      cooldownHours?: number;
    },
  ): void {
    this.ensureLoaded();
    const now = Date.now();
    const hours = params.cooldownHours ?? this.cooldownHours;
    const entry: PoolMemoryEntry = {
      poolAddress: params.poolAddress,
      poolName: params.poolName,
      lastClosedAt: now,
      cooldownUntil: now + hours * 60 * 60 * 1000,
      exitReason: params.exitReason,
      pnlPct: params.pnlPct,
      note: params.note,
    };
    this.entries.set(entry.poolAddress, entry);
    this.save();
    logger.info(
      {
        poolAddress: entry.poolAddress,
        exitReason: entry.exitReason,
        pnlPct: entry.pnlPct,
        cooldownUntil: new Date(entry.cooldownUntil).toISOString(),
      },
      "pool-memory-store: recorded close",
    );
  }

  /** Attach or update a freeform note on an existing entry. */
  setNote(poolAddress: string, note: string): boolean {
    this.ensureLoaded();
    const entry = this.entries.get(poolAddress);
    if (!entry) return false;
    this.entries.set(poolAddress, { ...entry, note });
    this.save();
    return true;
  }

  /** Remove a pool from memory (lifts cooldown immediately). */
  forget(poolAddress: string): boolean {
    this.ensureLoaded();
    const existed = this.entries.delete(poolAddress);
    if (existed) {
      this.save();
      logger.info({ poolAddress }, "pool-memory-store: forgotten");
    }
    return existed;
  }

  get size(): number {
    this.ensureLoaded();
    return this.entries.size;
  }
}
