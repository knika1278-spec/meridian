import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DecisionJournal } from "../decision-journal.js";

let tmpDir: string;
let journalPath: string;

function makeTmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `decision-journal-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendSample(
  journal: DecisionJournal,
  overrides: Partial<Parameters<DecisionJournal["append"]>[0]> = {},
): string {
  const entry = journal.append({
    timestamp: Date.now(),
    actor: "SCREENER",
    event: "SCREEN_DECISION",
    subject: {
      poolAddress: "pool-alpha",
      poolName: "ALPHA-USDC",
      tokenSymbols: ["ALPHA", "USDC"],
    },
    action: "ENTER",
    status: "PROPOSED",
    summary: "ENTER ALPHA-USDC",
    reasons: ["fees strong"],
    risks: [],
    metrics: { confidence: 0.7 },
    rejectedAlternatives: ["WATCH", "SKIP"],
    linkedIds: { cycleId: "cycle-1" },
    dryRun: true,
    ...overrides,
  });
  return entry.id;
}

describe("DecisionJournal", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
    journalPath = path.join(tmpDir, "decision-journal.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("append + readAll preserves entries and generates IDs", () => {
    const journal = new DecisionJournal(journalPath);
    const id = appendSample(journal);

    const all = journal.readAll();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0]?.id, id);
    assert.match(id, /^DJ-/);
    assert.strictEqual(all[0]?.subject.poolName, "ALPHA-USDC");
  });

  it("getRecentDecisions filters by pool name, address, actor, and event", () => {
    const journal = new DecisionJournal(journalPath);
    appendSample(journal, { timestamp: 100, actor: "SCREENER" });
    appendSample(journal, {
      timestamp: 200,
      actor: "MANAGER",
      event: "MANAGER_DECISION",
      subject: {
        poolAddress: "pool-beta",
        poolName: "BETA-SOL",
        positionPubkey: "pos-beta",
        tokenSymbols: ["BETA", "SOL"],
      },
      action: "CLOSE",
      summary: "CLOSE BETA-SOL",
    });

    assert.strictEqual(
      journal.getRecentDecisions({ poolName: "alpha", limit: 10 }).length,
      1,
    );
    assert.strictEqual(
      journal.getRecentDecisions({ poolAddress: "pool-beta", limit: 10 })[0]
        ?.subject.positionPubkey,
      "pos-beta",
    );
    assert.strictEqual(
      journal.getRecentDecisions({ actor: "MANAGER", limit: 10 }).length,
      1,
    );
    assert.strictEqual(
      journal.getRecentDecisions({ event: "SCREEN_DECISION", limit: 10 })
        .length,
      1,
    );
  });

  it("recent sorts newest first and honors limit", () => {
    const journal = new DecisionJournal(journalPath);
    appendSample(journal, { timestamp: 100, summary: "old" });
    appendSample(journal, { timestamp: 300, summary: "new" });
    appendSample(journal, { timestamp: 200, summary: "mid" });

    const recent = journal.recent(2);
    assert.deepStrictEqual(
      recent.map((entry) => entry.summary),
      ["new", "mid"],
    );
  });

  it("readAll tolerates corrupt JSONL lines", () => {
    const valid = JSON.stringify({
      id: "DJ-valid",
      timestamp: 1,
      actor: "SCREENER",
      event: "SCREEN_DECISION",
      subject: { poolAddress: "pool", poolName: "POOL-USDC" },
      action: "WATCH",
      status: "PROPOSED",
      summary: "valid",
      reasons: [],
      risks: [],
      metrics: {},
      rejectedAlternatives: [],
      linkedIds: {},
      dryRun: true,
    });
    fs.writeFileSync(journalPath, `${valid}\n{bad json}\n`, "utf-8");

    const journal = new DecisionJournal(journalPath);
    assert.strictEqual(journal.readAll().length, 1);
  });
});
