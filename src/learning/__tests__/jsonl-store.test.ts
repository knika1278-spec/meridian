// Unit tests for JsonlStore.
// Uses node:test runner via tsx --test.

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { JsonlStore } from "../jsonl-store.js";

interface TestRecord extends Record<string, unknown> {
  id: number;
  name: string;
}

interface TimestampedRecord extends Record<string, unknown> {
  timestamp: number;
  value: string;
}

interface KindedRecord extends Record<string, unknown> {
  kind: string;
  payload: number;
}

function makeTmpDir(): string {
  const base = path.join(
    os.tmpdir(),
    `jsonl-store-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  );
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function cleanupTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("JsonlStore", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    filePath = path.join(tmpDir, "store.jsonl");
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it("empty file → readAll returns [] and count is 0", () => {
    const store = new JsonlStore<TestRecord>(filePath);
    assert.deepStrictEqual(store.readAll(), []);
    assert.strictEqual(store.count(), 0);
  });

  it("append + readAll preserves insertion order", () => {
    const store = new JsonlStore<TestRecord>(filePath);
    store.append({ id: 1, name: "alpha" });
    store.append({ id: 2, name: "bravo" });
    store.append({ id: 3, name: "charlie" });

    const records = store.readAll();
    assert.strictEqual(records.length, 3);
    assert.strictEqual(records[0]?.id, 1);
    assert.strictEqual(records[1]?.id, 2);
    assert.strictEqual(records[2]?.id, 3);
    assert.strictEqual(records[0]?.name, "alpha");
    assert.strictEqual(records[2]?.name, "charlie");
  });

  it("appendMany bulk-appends and count reflects total", () => {
    const store = new JsonlStore<TestRecord>(filePath);
    const records: TestRecord[] = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
      { id: 4, name: "d" },
      { id: 5, name: "e" },
    ];
    store.appendMany(records);
    assert.strictEqual(store.count(), 5);
  });

  it("tolerates corrupt middle line — skips bad, returns valid", () => {
    const validA = JSON.stringify({ id: 1, name: "a" });
    const validB = JSON.stringify({ id: 2, name: "b" });
    const validC = JSON.stringify({ id: 3, name: "c" });
    const corrupt = "{this is not json}";
    const content = `${validA}\n${corrupt}\n${validB}\n${validC}\n`;
    fs.writeFileSync(filePath, content, "utf-8");

    const store = new JsonlStore<TestRecord>(filePath);
    let records: TestRecord[] = [];
    assert.doesNotThrow(() => {
      records = store.readAll();
    });
    assert.strictEqual(records.length, 3);
    assert.deepStrictEqual(
      records.map((r) => r.id),
      [1, 2, 3],
    );
  });

  it("tolerates partial last line without trailing newline", () => {
    const validA = JSON.stringify({ id: 1, name: "a" });
    const validB = JSON.stringify({ id: 2, name: "b" });
    // Partial = not valid JSON, no trailing newline.
    const partial = '{"id":3,"name":"c"';
    const content = `${validA}\n${validB}\n${partial}`;
    fs.writeFileSync(filePath, content, "utf-8");

    const store = new JsonlStore<TestRecord>(filePath);
    let records: TestRecord[] = [];
    assert.doesNotThrow(() => {
      records = store.readAll();
    });
    // Partial is invalid → skipped. Valid lines still returned, no throw.
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0]?.id, 1);
    assert.strictEqual(records[1]?.id, 2);
  });

  it("readSince filters by numeric timestamp key (ts >= cutoff)", () => {
    const store = new JsonlStore<TimestampedRecord>(filePath);
    store.append({ timestamp: 100, value: "low" });
    store.append({ timestamp: 200, value: "mid" });
    store.append({ timestamp: 300, value: "high" });

    const result = store.readSince(200, "timestamp");
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(
      result.map((r) => r.timestamp),
      [200, 300],
    );
  });

  it("readByPredicate returns only matching records", () => {
    const store = new JsonlStore<KindedRecord>(filePath);
    store.append({ kind: "alpha", payload: 1 });
    store.append({ kind: "beta", payload: 2 });
    store.append({ kind: "alpha", payload: 3 });
    store.append({ kind: "gamma", payload: 4 });

    const result = store.readByPredicate((r) => r.kind === "alpha");
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(
      result.map((r) => r.payload),
      [1, 3],
    );
  });

  it("path() returns the resolved absolute path", () => {
    const store = new JsonlStore<TestRecord>(filePath);
    const resolved = store.path();
    assert.strictEqual(path.isAbsolute(resolved), true);
    assert.strictEqual(resolved, path.resolve(filePath));
  });
});
