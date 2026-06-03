import crypto from "node:crypto";
import type {
  DecisionActor,
  DecisionEvent,
  DecisionJournalEntry,
} from "../types/index.js";
import { childLogger } from "../utils/logger.js";
import { JsonlStore } from "../learning/jsonl-store.js";

const log = childLogger("decision-journal");

export type DecisionJournalRecord = DecisionJournalEntry &
  Record<string, unknown>;

export interface DecisionJournalQuery {
  poolAddress?: string;
  poolName?: string;
  positionPubkey?: string;
  actor?: DecisionActor;
  event?: DecisionEvent;
  since?: number;
  limit?: number;
}

export type DecisionJournalInput = Partial<
  Pick<DecisionJournalEntry, "id" | "timestamp">
> &
  Omit<DecisionJournalEntry, "id" | "timestamp">;

export type DecisionJournalAppendListener = (
  entry: DecisionJournalEntry,
) => void;

export class DecisionJournal {
  private readonly store: JsonlStore<DecisionJournalRecord>;
  private readonly listeners = new Set<DecisionJournalAppendListener>();

  constructor(filePath: string) {
    this.store = new JsonlStore<DecisionJournalRecord>(filePath);
  }

  append(input: DecisionJournalInput): DecisionJournalEntry {
    const timestamp = input.timestamp ?? Date.now();
    const entry: DecisionJournalEntry = {
      ...input,
      id: input.id ?? buildJournalId(timestamp, input),
      timestamp,
      subject: {
        ...input.subject,
        tokenSymbols: compactStrings(input.subject.tokenSymbols ?? []),
      },
      reasons: compactStrings(input.reasons ?? []),
      risks: compactStrings(input.risks ?? []),
      metrics: sanitizeMetrics(input.metrics ?? {}),
      rejectedAlternatives: compactStrings(input.rejectedAlternatives ?? []),
      linkedIds: sanitizeLinkedIds(input.linkedIds ?? {}),
      raw: input.raw ? input.raw.slice(0, 500) : undefined,
    };
    this.store.append(entry as DecisionJournalRecord);
    this.notifyAppend(entry);
    return entry;
  }

  safeAppend(input: DecisionJournalInput): DecisionJournalEntry | null {
    try {
      return this.append(input);
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          actor: input.actor,
          event: input.event,
          pool: input.subject.poolAddress ?? input.subject.poolName,
          positionPubkey: input.subject.positionPubkey,
        },
        "decision journal append failed",
      );
      return null;
    }
  }

  readAll(): DecisionJournalEntry[] {
    return this.store.readAll();
  }

  recent(
    limit: number,
    query: Omit<DecisionJournalQuery, "limit"> = {},
  ): DecisionJournalEntry[] {
    return this.getRecentDecisions({ ...query, limit });
  }

  getRecentDecisions(query: DecisionJournalQuery = {}): DecisionJournalEntry[] {
    const limit = Math.max(0, query.limit ?? 20);
    if (limit === 0) return [];

    return this.store
      .readAll()
      .filter((entry) => matchesQuery(entry, query))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  path(): string {
    return this.store.path();
  }

  onAppend(listener: DecisionJournalAppendListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyAppend(entry: DecisionJournalEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (err) {
        log.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            journalId: entry.id,
          },
          "decision journal append listener failed",
        );
      }
    }
  }
}

function matchesQuery(
  entry: DecisionJournalEntry,
  query: DecisionJournalQuery,
): boolean {
  if (query.since !== undefined && entry.timestamp < query.since) return false;
  if (query.actor && entry.actor !== query.actor) return false;
  if (query.event && entry.event !== query.event) return false;
  if (
    query.poolAddress &&
    normalize(entry.subject.poolAddress) !== normalize(query.poolAddress)
  ) {
    return false;
  }
  if (
    query.positionPubkey &&
    normalize(entry.subject.positionPubkey) !== normalize(query.positionPubkey)
  ) {
    return false;
  }
  if (query.poolName) {
    const needle = normalize(query.poolName);
    const pool = normalize(entry.subject.poolName);
    if (!pool.includes(needle)) return false;
  }
  return true;
}

function buildJournalId(
  timestamp: number,
  input: DecisionJournalInput,
): string {
  const date = new Date(timestamp).toISOString().replace(/[-:.TZ]/g, "");
  const payload = JSON.stringify({
    timestamp,
    actor: input.actor,
    event: input.event,
    subject: input.subject,
    action: input.action,
    summary: input.summary,
    nonce: Math.random().toString(36),
  });
  const hash = crypto
    .createHash("sha1")
    .update(payload)
    .digest("hex")
    .slice(0, 8);
  return `DJ-${date.slice(0, 14)}-${input.actor}-${input.event}-${hash}`;
}

function sanitizeMetrics(
  metrics: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (value === undefined) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeLinkedIds(
  linkedIds: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(linkedIds)) {
    if (value && value.trim().length > 0) out[key] = value;
  }
  return out;
}

function compactStrings(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
