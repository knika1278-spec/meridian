import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DecisionJournalEntry } from "../../types/index.js";
import {
  formatJournalEntry,
  parseTelegramCallback,
  shouldNotify,
  TelegramNotifier,
} from "../telegram.js";

let tmpDir: string;

function makeTmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `telegram-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEntry(
  overrides: Partial<DecisionJournalEntry> = {},
): DecisionJournalEntry {
  return {
    id: "DJ-test",
    timestamp: Date.now(),
    actor: "SCREENER",
    event: "SCREEN_DECISION",
    subject: {
      poolAddress: "pool-alpha",
      poolName: "ALPHA/USDC",
      tokenSymbols: ["ALPHA", "USDC"],
    },
    action: "ENTER",
    status: "PROPOSED",
    summary: "ENTER ALPHA/USDC",
    reasons: ["confidence high"],
    risks: [],
    metrics: { llmConfidence: 0.91, tvlUsd: 120000 },
    rejectedAlternatives: ["WATCH", "SKIP"],
    linkedIds: { cycleId: "cycle-1" },
    dryRun: true,
    ...overrides,
  };
}

describe("TelegramNotifier", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds modern control-center messages with inline buttons", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: {} }),
      } as Response;
    }) as typeof fetch;

    const notifier = new TelegramNotifier({
      botToken: "token",
      chatId: "123",
      dryRun: true,
      commandsFile: path.join(tmpDir, "commands.jsonl"),
      fetchFn,
    });

    await notifier.sendControlCenter();

    assert.strictEqual(calls.length, 1);
    assert.match(calls[0]?.url ?? "", /sendMessage$/);
    const markup = calls[0]?.body.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
    };
    assert.deepStrictEqual(
      markup.inline_keyboard[0]?.map((button) => button.text),
      ["Run Screen", "Run Manager"],
    );
    assert.deepStrictEqual(
      markup.inline_keyboard[1]?.map((button) => button.callback_data),
      ["report:decisions", "report:positions"],
    );
  });

  it("filters routine screen decisions and keeps important alerts", () => {
    assert.strictEqual(shouldNotify(makeEntry({ action: "ENTER" })), false);
    assert.strictEqual(shouldNotify(makeEntry({ action: "WATCH" })), false);
    assert.strictEqual(shouldNotify(makeEntry({ action: "SKIP" })), false);
    assert.strictEqual(
      shouldNotify(
        makeEntry({
          actor: "EXECUTOR",
          event: "OPEN_FAILED",
          action: "OPEN",
          status: "FAILED",
        }),
      ),
      true,
    );
  });

  it("formats journal entries without leaking raw HTML", () => {
    const message = formatJournalEntry(
      makeEntry({
        summary: "pool <script>alert(1)</script>",
        reasons: ["TVL > volume & safe"],
      }),
    );
    assert.match(message, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(message, /TVL &gt; volume &amp; safe/);
  });

  it("parses callback data", () => {
    assert.deepStrictEqual(parseTelegramCallback("cmd:screen"), {
      kind: "screen",
    });
    assert.deepStrictEqual(parseTelegramCallback("report:positions"), {
      kind: "positions",
    });
    assert.deepStrictEqual(parseTelegramCallback("pool:abc123"), {
      kind: "pool",
      poolAddress: "abc123",
    });
    assert.deepStrictEqual(parseTelegramCallback("nope"), { kind: "unknown" });
  });
});
