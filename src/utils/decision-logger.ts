import fs from "node:fs";
import path from "node:path";
import type { DecisionLogEntry, ScreeningResult } from "../types/index.js";

export class DecisionLogger {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath))
      fs.writeFileSync(this.filePath, "[]", "utf-8");
  }

  append(result: ScreeningResult, dryRun: boolean): void {
    const entry: DecisionLogEntry = {
      cycleId: result.cycleId,
      timestamp: result.timestamp,
      pool: { address: result.pool.address, name: result.pool.name },
      filtersPassed: result.filtersPassed,
      decision: result.decision,
      deployGate: result.deployGate,
      dryRun,
    };
    const arr = this.readAll();
    arr.push(entry);
    fs.writeFileSync(this.filePath, JSON.stringify(arr, null, 2), "utf-8");
  }

  readAll(): DecisionLogEntry[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as DecisionLogEntry[]) : [];
    } catch {
      return [];
    }
  }

  recent(n: number): DecisionLogEntry[] {
    const all = this.readAll();
    return all.slice(-n);
  }

  path(): string {
    return this.filePath;
  }
}
