import fs from "node:fs";
import path from "node:path";

/**
 * Append-only JSONL writer. Each `append()` schedules exactly one line
 * (`JSON.stringify(record) + "\n"`) to be written asynchronously via
 * `setImmediate` + `fs.promises.appendFile`, keeping the event loop free.
 *
 * Designed for the web bridge to tail. Failures are swallowed and logged
 * to stderr — emitters must never break the agent.
 */
export class JsonlEmitter {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    const dir = path.dirname(this.filePath);
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Touch the file so tailers attach immediately.
      if (!fs.existsSync(this.filePath))
        fs.writeFileSync(this.filePath, "", "utf-8");
    } catch (err) {
      process.stderr.write(
        `[jsonl-emitter] failed to prepare ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  append(record: unknown): void {
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch (err) {
      process.stderr.write(
        `[jsonl-emitter] non-serializable record for ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return;
    }
    const filePath = this.filePath;
    setImmediate(() => {
      fs.promises.appendFile(filePath, `${line}\n`, "utf-8").catch((err) => {
        process.stderr.write(
          `[jsonl-emitter] append failed for ${filePath}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      });
    });
  }

  /**
   * Synchronous append — writes the line immediately via `fs.appendFileSync`.
   * Use when the caller needs write-then-read semantics (e.g. learning stores,
   * decision journal). Errors are swallowed and written to stderr so callers
   * are never interrupted by disk I/O failures.
   */
  appendSync(record: unknown): void {
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch (err) {
      process.stderr.write(
        `[jsonl-emitter] non-serializable record for ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return;
    }
    try {
      fs.appendFileSync(this.filePath, `${line}\n`, "utf-8");
    } catch (err) {
      process.stderr.write(
        `[jsonl-emitter] appendSync failed for ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  path(): string {
    return this.filePath;
  }
}

/**
 * Standalone async JSONL append — defers the write via `setImmediate` so it
 * never blocks the event loop. Errors are swallowed and written to stderr so
 * callers are never interrupted by disk I/O failures.
 *
 * Crash-safe: `fs.promises.appendFile` is atomic at the OS level for small
 * writes, so a process crash mid-call at worst leaves the last line incomplete;
 * all prior lines remain valid JSONL.
 */
export function asyncAppendJsonl(filePath: string, data: unknown): void {
  let line: string;
  try {
    line = JSON.stringify(data);
  } catch (err) {
    process.stderr.write(
      `[jsonl-emitter] non-serializable record for ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return;
  }
  setImmediate(() => {
    fs.promises.appendFile(filePath, `${line}\n`, "utf-8").catch((err) => {
      process.stderr.write(
        `[jsonl-emitter] append failed for ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    });
  });
}
