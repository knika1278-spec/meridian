// Read+append helper for learning JSONL files.
// Writes are synchronous so readAll() always reflects the latest state.
// (JsonlEmitter uses async/deferred writes which breaks immediate readback.)

import fs from "node:fs";
import path from "node:path";
import { childLogger, type Logger } from "../utils/logger.js";

const log: Logger = childLogger("jsonl-store");

export class JsonlStore<T extends Record<string, unknown>> {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath))
      fs.writeFileSync(this.filePath, "", "utf-8");
  }

  append(record: T): void {
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch (err) {
      log.warn(
        { filePath: this.filePath, err },
        "non-serializable record, skipping",
      );
      return;
    }
    fs.appendFileSync(this.filePath, `${line}\n`, "utf-8");
  }

  appendMany(records: T[]): void {
    if (records.length === 0) return;
    const lines = records
      .map((r) => {
        try {
          return JSON.stringify(r);
        } catch {
          log.warn(
            { filePath: this.filePath },
            "non-serializable record in batch, skipping",
          );
          return null;
        }
      })
      .filter((l): l is string => l !== null)
      .join("\n");
    fs.appendFileSync(this.filePath, `${lines}\n`, "utf-8");
  }

  /** Returns all valid records. Skips corrupt lines (logs warning) and tolerates a partial last line without a trailing newline. */
  readAll(): T[] {
    if (!fs.existsSync(this.filePath)) return [];

    const raw = fs.readFileSync(this.filePath, "utf-8");
    if (raw.length === 0) return [];

    const lines = raw.split("\n");
    const records: T[] = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line === undefined || line.length === 0) continue;

      try {
        const parsed = JSON.parse(line) as T;
        records.push(parsed);
      } catch (err) {
        log.warn(
          { filePath: this.filePath, lineIndex, err },
          "skipping corrupt jsonl line",
        );
      }
    }

    return records;
  }

  /** Filter by a numeric timestamp key. */
  readSince(timestamp: number, tsKey: keyof T): T[] {
    return this.readAll().filter((rec) => {
      const value = rec[tsKey];
      return typeof value === "number" && value >= timestamp;
    });
  }

  readByPredicate(fn: (rec: T) => boolean): T[] {
    return this.readAll().filter(fn);
  }

  count(): number {
    return this.readAll().length;
  }

  path(): string {
    return this.filePath;
  }
}
