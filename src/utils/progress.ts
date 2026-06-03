import type {
  BotProgressEvent,
  ProgressSource,
  ProgressStatus,
} from "../types/index.js";
import type { JsonlEmitter } from "./jsonl-emitter.js";

export type ProgressSink = (event: BotProgressEvent) => void;

export interface ProgressReporterOptions {
  source: ProgressSource;
  cycleId: string;
  emitter?: JsonlEmitter;
  sink?: ProgressSink;
  commandId?: string;
}

export interface ProgressUpdate {
  phase: string;
  status?: ProgressStatus;
  percent: number;
  message: string;
  detail?: string;
  current?: number;
  total?: number;
  poolAddress?: string;
  poolName?: string;
  positionPubkey?: string;
}

export class ProgressReporter {
  private readonly source: ProgressSource;
  private readonly cycleId: string;
  private readonly emitter?: JsonlEmitter;
  private readonly sink?: ProgressSink;
  private readonly commandId?: string;
  private readonly startedAt = Date.now();
  private seq = 0;

  constructor(opts: ProgressReporterOptions) {
    this.source = opts.source;
    this.cycleId = opts.cycleId;
    this.emitter = opts.emitter;
    this.sink = opts.sink;
    this.commandId = opts.commandId;
  }

  emit(update: ProgressUpdate): BotProgressEvent {
    const updatedAt = Date.now();
    const event: BotProgressEvent = {
      id: `${this.cycleId}-${this.source.toLowerCase()}-${this.seq++}`,
      cycleId: this.cycleId,
      source: this.source,
      phase: update.phase,
      status: update.status ?? "running",
      percent: clampPercent(update.percent),
      message: update.message,
      startedAt: this.startedAt,
      updatedAt,
      ...(update.detail ? { detail: update.detail } : {}),
      ...(typeof update.current === "number"
        ? { current: update.current }
        : {}),
      ...(typeof update.total === "number" ? { total: update.total } : {}),
      ...(typeof this.commandId === "string"
        ? { commandId: this.commandId }
        : {}),
      ...(update.poolAddress ? { poolAddress: update.poolAddress } : {}),
      ...(update.poolName ? { poolName: update.poolName } : {}),
      ...(update.positionPubkey
        ? { positionPubkey: update.positionPubkey }
        : {}),
    };
    const etaMs = estimateEtaMs(event);
    if (typeof etaMs === "number") event.etaMs = etaMs;

    try {
      this.emitter?.append(event);
    } catch {
      // Progress must never affect trading cycles.
    }
    try {
      this.sink?.(event);
    } catch {
      // UI callbacks are best-effort too.
    }
    return event;
  }
}

export function formatProgressLine(event: BotProgressEvent): string {
  const parts = [
    `[${event.source.toLowerCase()}]`,
    `${event.percent.toFixed(0)}%`,
    event.phase,
    event.message,
  ];
  if (
    typeof event.current === "number" &&
    typeof event.total === "number" &&
    event.total > 0
  ) {
    parts.push(`(${event.current}/${event.total})`);
  }
  if (typeof event.etaMs === "number" && event.status === "running") {
    parts.push(`eta ${formatDuration(event.etaMs)}`);
  }
  return parts.join(" ");
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function estimateEtaMs(event: BotProgressEvent): number | undefined {
  if (event.percent <= 0 || event.percent >= 100) return undefined;
  const elapsed = event.updatedAt - event.startedAt;
  if (elapsed < 500) return undefined;
  const total = elapsed / (event.percent / 100);
  return Math.max(0, Math.round(total - elapsed));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}
