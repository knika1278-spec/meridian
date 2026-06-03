import fs from "node:fs";
import path from "node:path";
import type { BlacklistEntry } from "../types/index.js";
import { logger } from "../utils/logger.js";

const DEFAULT_FILE = "./data/token-blacklist.json";

export class BlacklistStore {
  private readonly file: string;
  private entries: Map<string, BlacklistEntry> = new Map();
  private loaded = false;

  constructor(file?: string) {
    this.file = file ?? DEFAULT_FILE;
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
      const arr = JSON.parse(raw) as BlacklistEntry[];
      this.entries = new Map(arr.map((e) => [e.mint, e]));
      logger.debug(
        { count: this.entries.size, file: this.file },
        "blacklist-store: loaded",
      );
    } catch (err) {
      logger.error(
        { err, file: this.file },
        "blacklist-store: failed to load — starting empty",
      );
      this.entries = new Map();
    }
    this.loaded = true;
  }

  private save(): void {
    this.ensureDir();
    const arr = [...this.entries.values()].sort(
      (a, b) => b.addedAt - a.addedAt,
    );
    try {
      fs.writeFileSync(this.file, JSON.stringify(arr, null, 2), "utf-8");
    } catch (err) {
      logger.error({ err, file: this.file }, "blacklist-store: failed to save");
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load();
  }

  isBlacklisted(mint: string): boolean {
    this.ensureLoaded();
    return this.entries.has(mint);
  }

  list(): BlacklistEntry[] {
    this.ensureLoaded();
    return [...this.entries.values()].sort((a, b) => b.addedAt - a.addedAt);
  }

  add(entry: BlacklistEntry): void {
    this.ensureLoaded();
    this.entries.set(entry.mint, entry);
    this.save();
    logger.info(
      {
        mint: entry.mint,
        symbol: entry.symbol,
        reason: entry.reason,
        source: entry.source,
      },
      "blacklist-store: added",
    );
  }

  addBot(mint: string, symbol: string, reason: string): void {
    this.add({ mint, symbol, addedAt: Date.now(), reason, source: "bot" });
  }

  addUser(mint: string, symbol: string, reason: string): void {
    this.add({ mint, symbol, addedAt: Date.now(), reason, source: "user" });
  }

  remove(mint: string): boolean {
    this.ensureLoaded();
    const existed = this.entries.delete(mint);
    if (existed) {
      this.save();
      logger.info({ mint }, "blacklist-store: removed");
    }
    return existed;
  }

  get size(): number {
    this.ensureLoaded();
    return this.entries.size;
  }
}
