import fs from "node:fs";
import path from "node:path";

// ---- Raw record shapes (only fields the graph reads) -----------------------

export interface RawJournal {
  id: string;
  timestamp: number;
  actor?: string;
  event?: string;
  subject?: {
    poolAddress?: string;
    poolName?: string;
    positionPubkey?: string;
    tokenSymbols?: string[];
  };
  action?: string;
  status?: string;
  summary?: string;
  reasons?: string[];
  risks?: string[];
  linkedIds?: Record<string, string | undefined>;
  dryRun?: boolean;
}

export interface RawDecision {
  id: string;
  kind?: string;
  timestamp: number;
  cycleId?: string;
  pool?: { address?: string; name?: string };
  positionPubkey?: string;
  action?: string;
  confidence?: number;
  reasons?: string[];
  risks?: string[];
  features?: Record<string, unknown>;
}

export interface RawShadow {
  decisionId: string;
  generatedAt: number;
  bucketKey?: string;
  expectedScore?: number;
  riskScore?: number;
  sampleSize?: number;
  confidence?: number;
  topEvidence?: { decisionId: string; score?: number; summary?: string }[];
  disagreement?: {
    llmAction?: string;
    shadowRecommendation?: string;
    magnitude?: number;
  };
}

export interface RawOutcome {
  decisionId: string;
  horizonMinutes: number;
  kind?: string;
  evaluatedAt: number;
  netPnlRiskScore?: number;
}

export interface RawLesson {
  id: string;
  timestamp: number;
  poolName?: string;
  tags?: string[];
  ruleForFuture?: string;
}

export interface RawPosition {
  positionPubkey: string;
  poolAddress?: string;
  poolName?: string;
  tokenX?: { symbol?: string };
  tokenY?: { symbol?: string };
  openedAt?: number;
  cycleIdOnEnter?: string;
}

export interface RawClosed {
  position: RawPosition;
  closedAt?: number;
  exitReason?: string;
  pnlUsd?: number;
}

export interface RawData {
  dataDir: string;
  journals: RawJournal[];
  decisions: RawDecision[];
  shadows: RawShadow[];
  outcomes: RawOutcome[];
  lessons: RawLesson[];
  positions: RawPosition[];
  closed: RawClosed[];
  warnings: string[];
}

// ---- Data dir resolution ---------------------------------------------------

/** Resolve the agent's data directory. Honors DATA_DIR; otherwise tries the
 * sibling `../data` (web runs from web/) then `./data` (run from project root). */
export function resolveDataDir(): string {
  const candidates = [
    process.env.DATA_DIR,
    path.resolve(process.cwd(), "..", "data"),
    path.resolve(process.cwd(), "data"),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }
  return candidates[0] ?? path.resolve(process.cwd(), "..", "data");
}

// ---- Safe readers ----------------------------------------------------------

function readJsonl<T>(dir: string, file: string, warnings: string[]): T[] {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return [];
  let text: string;
  try {
    text = fs.readFileSync(full, "utf-8");
  } catch (err) {
    warnings.push(`Could not read ${file}: ${errMsg(err)}`);
    return [];
  }
  const out: T[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      bad += 1;
    }
  }
  if (bad > 0) warnings.push(`${file}: skipped ${bad} unparseable line(s)`);
  return out;
}

function readJsonArray<T>(dir: string, file: string, warnings: string[]): T[] {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(full, "utf-8")) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    warnings.push(`${file}: ${errMsg(err)}`);
    return [];
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function loadRawData(dataDir = resolveDataDir()): RawData {
  const warnings: string[] = [];
  if (!fs.existsSync(dataDir)) {
    warnings.push(`Data directory not found: ${dataDir}`);
  }
  return {
    dataDir,
    journals: readJsonl<RawJournal>(
      dataDir,
      "decision-journal.jsonl",
      warnings,
    ),
    decisions: readJsonl<RawDecision>(
      dataDir,
      "learning-decisions.jsonl",
      warnings,
    ),
    shadows: readJsonl<RawShadow>(dataDir, "shadow-scores.jsonl", warnings),
    outcomes: readJsonl<RawOutcome>(
      dataDir,
      "learning-outcomes.jsonl",
      warnings,
    ),
    lessons: [
      ...readJsonl<RawLesson>(dataDir, "learning-lessons.jsonl", warnings),
      ...readJsonArray<RawLesson>(dataDir, "lessons.json", warnings),
    ],
    positions: readJsonArray<RawPosition>(dataDir, "positions.json", warnings),
    closed: readJsonArray<RawClosed>(
      dataDir,
      "closed-positions.json",
      warnings,
    ),
    warnings,
  };
}
