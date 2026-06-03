// Deterministic decision IDs let us record a decision row now and backfill
// its outcome row hours later without coordination. Same inputs always hash
// to the same ID, making recording idempotent and outcome joins reliable.

import { createHash } from "node:crypto";

export function makeScreenerDecisionId(input: {
  cycleId: string;
  poolAddress: string;
  action: "ENTER" | "WATCH" | "SKIP";
}): string {
  const joined = `${input.cycleId}|${input.poolAddress}|${input.action}`;
  const digest = createHash("sha1").update(joined).digest("hex").slice(0, 16);
  return `sd_${digest}`;
}

export function makeManagerDecisionId(input: {
  positionPubkey: string;
  cycleTimestamp: number;
  action: "HOLD" | "CLAIM" | "CLOSE" | "REBALANCE";
}): string {
  const joined = `${input.positionPubkey}|${input.cycleTimestamp}|${input.action}`;
  const digest = createHash("sha1").update(joined).digest("hex").slice(0, 16);
  return `md_${digest}`;
}
