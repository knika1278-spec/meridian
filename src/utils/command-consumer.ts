import fs from "node:fs";
import path from "node:path";
import { childLogger, type Logger } from "../utils/logger.js";

export type CommandKind = "screen" | "manage" | "open" | "close" | "claim";

export interface BotCommand {
  ts: number;
  id: string;
  kind: CommandKind;
  args?: Record<string, unknown>;
}

export interface CommandConsumerOptions {
  filePath: string;
  /** Polling interval ms (default 1000). */
  pollMs?: number;
  /** Called for each new command. Must be idempotent; consumer dedupes by id. */
  onCommand: (cmd: BotCommand) => Promise<void> | void;
}

const VALID_KINDS: ReadonlySet<CommandKind> = new Set<CommandKind>([
  "screen",
  "manage",
  "open",
  "close",
  "claim",
]);

/**
 * Tails an append-only JSONL command file. On `start()`, captures the
 * current end-of-file byte offset and only emits commands appended after
 * that point. Commands are deduped by `id` (a single in-memory `Set` keyed
 * by command id, capped to 10k entries with FIFO eviction).
 *
 * IO + parse errors per line are logged and the line is skipped — the
 * consumer must never crash the bot loop.
 */
export class CommandConsumer {
  private readonly filePath: string;
  private readonly pollMs: number;
  private readonly onCommand: (cmd: BotCommand) => Promise<void> | void;
  private readonly log: Logger;
  /** Dedupe set keyed by command id. */
  private readonly seenIds = new Set<string>();
  /** FIFO list mirroring seenIds for bounded eviction. */
  private readonly seenOrder: string[] = [];
  private readonly seenLimit = 10_000;

  private offset = 0;
  /** Trailing bytes from the previous read that didn't end in `\n`. */
  private leftover = "";
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private polling = false;

  constructor(opts: CommandConsumerOptions) {
    this.filePath = path.resolve(opts.filePath);
    this.pollMs = opts.pollMs ?? 1000;
    this.onCommand = opts.onCommand;
    this.log = childLogger("command-consumer");
    this.ensureFile();
  }

  start(): void {
    if (this.running) {
      this.log.warn("start called but consumer already running");
      return;
    }
    // Tail from EOF: skip historical commands.
    try {
      const stat = fs.statSync(this.filePath);
      this.offset = stat.size;
    } catch (err) {
      this.log.warn(
        { err: errMessage(err), file: this.filePath },
        "failed to stat command file on start; offset=0",
      );
      this.offset = 0;
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollMs);
    this.log.info(
      { file: this.filePath, offset: this.offset, pollMs: this.pollMs },
      "command consumer started",
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.log.info("command consumer stopped");
  }

  // ---------- internals ----------

  private ensureFile(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, "", "utf-8");
      }
    } catch (err) {
      this.log.warn(
        { err: errMessage(err), file: this.filePath },
        "failed to ensure command file exists",
      );
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // never overlap polls
    this.polling = true;
    try {
      let size = 0;
      try {
        const stat = fs.statSync(this.filePath);
        size = stat.size;
      } catch (err) {
        // File may have been deleted/rotated. Recreate and skip.
        this.log.warn(
          { err: errMessage(err), file: this.filePath },
          "stat failed; recreating",
        );
        this.ensureFile();
        this.offset = 0;
        this.leftover = "";
        return;
      }

      if (size < this.offset) {
        // File was truncated or rotated. Start over from beginning.
        this.log.info(
          { prev: this.offset, size, file: this.filePath },
          "command file shrunk; resetting offset",
        );
        this.offset = 0;
        this.leftover = "";
      }

      if (size === this.offset) return;

      let chunk: Buffer;
      try {
        const fd = fs.openSync(this.filePath, "r");
        try {
          const length = size - this.offset;
          chunk = Buffer.alloc(length);
          fs.readSync(fd, chunk, 0, length, this.offset);
          this.offset = size;
        } finally {
          fs.closeSync(fd);
        }
      } catch (err) {
        this.log.warn(
          { err: errMessage(err), file: this.filePath },
          "read failed; will retry next tick",
        );
        return;
      }

      const text = this.leftover + chunk.toString("utf-8");
      const lines = text.split("\n");
      // Last element is the partial trailing line (or "" when chunk ended with \n).
      this.leftover = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0) continue;
        const cmd = this.parseLine(line);
        if (!cmd) continue;
        if (this.seenIds.has(cmd.id)) continue;
        this.markSeen(cmd.id);
        try {
          await this.onCommand(cmd);
        } catch (err) {
          this.log.warn(
            { err: errMessage(err), cmdId: cmd.id, kind: cmd.kind },
            "onCommand handler threw",
          );
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private parseLine(line: string): BotCommand | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.log.warn(
        { err: errMessage(err), lineHead: line.slice(0, 200) },
        "command line is not valid JSON; skipping",
      );
      return null;
    }
    if (!parsed || typeof parsed !== "object") {
      this.log.warn(
        { lineHead: line.slice(0, 200) },
        "command is not an object; skipping",
      );
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : "";
    const kind = typeof obj.kind === "string" ? obj.kind : "";
    const ts = typeof obj.ts === "number" ? obj.ts : Date.now();
    if (!id || !kind) {
      this.log.warn(
        { lineHead: line.slice(0, 200) },
        "command missing id/kind; skipping",
      );
      return null;
    }
    if (!VALID_KINDS.has(kind as CommandKind)) {
      this.log.warn({ id, kind }, "unknown command kind; skipping");
      return null;
    }
    const args =
      obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
        ? (obj.args as Record<string, unknown>)
        : undefined;
    const cmd: BotCommand = {
      ts,
      id,
      kind: kind as CommandKind,
      ...(args ? { args } : {}),
    };
    return cmd;
  }

  private markSeen(id: string): void {
    this.seenIds.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > this.seenLimit) {
      const evict = this.seenOrder.shift();
      if (evict !== undefined) this.seenIds.delete(evict);
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
