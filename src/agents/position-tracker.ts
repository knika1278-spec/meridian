import fs from "node:fs";
import path from "node:path";
import type { Position } from "../types/index.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("position-tracker");

export interface PositionTrackerOptions {
  filePath: string;
}

export class PositionTracker {
  private readonly filePath: string;
  private positions: Position[];

  constructor(opts: PositionTrackerOptions) {
    this.filePath = path.resolve(opts.filePath);
    this.ensureFile();
    this.positions = this.readFromDisk();
  }

  listOpen(): Position[] {
    return [...this.positions];
  }

  get(positionPubkey: string): Position | null {
    return (
      this.positions.find((p) => p.positionPubkey === positionPubkey) ?? null
    );
  }

  add(position: Position): void {
    if (this.get(position.positionPubkey)) {
      throw new Error(`Position already exists: ${position.positionPubkey}`);
    }
    this.positions.push(position);
    this.flush();
  }

  remove(positionPubkey: string): Position | null {
    const idx = this.positions.findIndex(
      (p) => p.positionPubkey === positionPubkey,
    );
    if (idx === -1) return null;
    const removed = this.positions[idx];
    if (!removed) return null;
    this.positions.splice(idx, 1);
    this.flush();
    return removed;
  }

  update(positionPubkey: string, patch: Partial<Position>): Position | null {
    const idx = this.positions.findIndex(
      (p) => p.positionPubkey === positionPubkey,
    );
    if (idx === -1) return null;
    const existing = this.positions[idx];
    if (!existing) return null;
    const merged: Position = {
      ...existing,
      ...patch,
      // Preserve the canonical pubkey; it must not be patched away.
      positionPubkey: existing.positionPubkey,
    };
    this.positions[idx] = merged;
    this.flush();
    return merged;
  }

  count(): number {
    return this.positions.length;
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
        "failed to ensure positions file",
      );
    }
  }

  private readFromDisk(): Position[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        log.warn(
          { path: this.filePath },
          "positions file not array, resetting",
        );
        return [];
      }
      return parsed as Position[];
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "corrupt or unreadable positions file, treating as empty",
      );
      return [];
    }
  }

  private flush(): void {
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.positions, null, 2),
        "utf-8",
      );
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          path: this.filePath,
        },
        "failed to write positions file",
      );
    }
  }
}
