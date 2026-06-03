// Unit tests for deterministic decision-id helpers.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  makeManagerDecisionId,
  makeScreenerDecisionId,
} from "../decision-id.js";

describe("makeScreenerDecisionId", () => {
  it("is deterministic for the same inputs", () => {
    const input = {
      cycleId: "cycle-001",
      poolAddress: "PoolAddr111",
      action: "ENTER" as const,
    };
    const a = makeScreenerDecisionId(input);
    const b = makeScreenerDecisionId(input);
    assert.strictEqual(a, b);
  });

  it("changes when action changes", () => {
    const base = {
      cycleId: "cycle-001",
      poolAddress: "PoolAddr111",
    };
    const idEnter = makeScreenerDecisionId({ ...base, action: "ENTER" });
    const idWatch = makeScreenerDecisionId({ ...base, action: "WATCH" });
    const idSkip = makeScreenerDecisionId({ ...base, action: "SKIP" });

    assert.notStrictEqual(idEnter, idWatch);
    assert.notStrictEqual(idEnter, idSkip);
    assert.notStrictEqual(idWatch, idSkip);
  });

  it("changes when poolAddress changes", () => {
    const base = {
      cycleId: "cycle-001",
      action: "ENTER" as const,
    };
    const idA = makeScreenerDecisionId({ ...base, poolAddress: "PoolA" });
    const idB = makeScreenerDecisionId({ ...base, poolAddress: "PoolB" });
    assert.notStrictEqual(idA, idB);
  });

  it("uses the 'sd_' prefix", () => {
    const id = makeScreenerDecisionId({
      cycleId: "c1",
      poolAddress: "p1",
      action: "ENTER",
    });
    assert.strictEqual(id.startsWith("sd_"), true);
  });

  it("is exactly 19 chars (prefix 3 + 16 hex)", () => {
    const id = makeScreenerDecisionId({
      cycleId: "c1",
      poolAddress: "p1",
      action: "ENTER",
    });
    assert.strictEqual(id.length, 19);
    const hex = id.slice(3);
    assert.match(hex, /^[0-9a-f]{16}$/);
  });
});

describe("makeManagerDecisionId", () => {
  it("is deterministic for the same inputs", () => {
    const input = {
      positionPubkey: "PosPubkey111",
      cycleTimestamp: 1_700_000_000,
      action: "HOLD" as const,
    };
    const a = makeManagerDecisionId(input);
    const b = makeManagerDecisionId(input);
    assert.strictEqual(a, b);
  });

  it("changes when action changes", () => {
    const base = {
      positionPubkey: "PosPubkey111",
      cycleTimestamp: 1_700_000_000,
    };
    const idHold = makeManagerDecisionId({ ...base, action: "HOLD" });
    const idClaim = makeManagerDecisionId({ ...base, action: "CLAIM" });
    const idClose = makeManagerDecisionId({ ...base, action: "CLOSE" });
    const idRebal = makeManagerDecisionId({ ...base, action: "REBALANCE" });

    assert.notStrictEqual(idHold, idClaim);
    assert.notStrictEqual(idHold, idClose);
    assert.notStrictEqual(idHold, idRebal);
    assert.notStrictEqual(idClaim, idClose);
    assert.notStrictEqual(idClose, idRebal);
  });

  it("uses the 'md_' prefix", () => {
    const id = makeManagerDecisionId({
      positionPubkey: "p1",
      cycleTimestamp: 1,
      action: "HOLD",
    });
    assert.strictEqual(id.startsWith("md_"), true);
  });

  it("is exactly 19 chars (prefix 3 + 16 hex)", () => {
    const id = makeManagerDecisionId({
      positionPubkey: "p1",
      cycleTimestamp: 1,
      action: "HOLD",
    });
    assert.strictEqual(id.length, 19);
    const hex = id.slice(3);
    assert.match(hex, /^[0-9a-f]{16}$/);
  });
});
