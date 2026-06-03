#!/usr/bin/env tsx
// Recomputes proxy-formula outcomes using the current SCORE_VERSION formula.
// Reads learning-outcomes.jsonl, rewrites proxy scores to the new LP-aware formula.
// Output: data/learning-outcomes-v<N>.jsonl  (never overwrites originals).
// Usage:  npm run learning:recompute [outcomes-file]
// Downstream consumers should filter on scoreVersion === SCORE_VERSION.

import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import type { LearningOutcome } from "../types/index.js";
import { scoreNetPnlRisk, SCORE_VERSION } from "./score-net-pnl-risk.js";

const DEFAULT_OUTCOMES_FILE = "./data/learning-outcomes.jsonl";

async function main(): Promise<void> {
  const outcomesFile = process.argv[2] ?? DEFAULT_OUTCOMES_FILE;

  if (!fs.existsSync(outcomesFile)) {
    console.error(`Outcomes file not found: ${outcomesFile}`);
    process.exit(1);
  }

  const outputFile = path.join(
    path.dirname(outcomesFile),
    `learning-outcomes-v${SCORE_VERSION}.jsonl`,
  );

  const rl = readline.createInterface({
    input: fs.createReadStream(outcomesFile),
  });
  const out = fs.createWriteStream(outputFile);
  let recomputed = 0;
  let kept = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let outcome: LearningOutcome & { scoreVersion?: number };
    try {
      outcome = JSON.parse(line) as LearningOutcome & { scoreVersion?: number };
    } catch {
      continue;
    }

    // Already on current version — copy through unchanged.
    if (outcome.scoreVersion === SCORE_VERSION) {
      out.write(JSON.stringify(outcome) + "\n");
      kept++;
      continue;
    }

    // Realized outcomes use actual PnL; only stamp the version, don't rescore.
    if (outcome.kind !== "entry_market_proxy") {
      out.write(
        JSON.stringify({ ...outcome, scoreVersion: SCORE_VERSION }) + "\n",
      );
      kept++;
      continue;
    }

    // Proxy outcomes: recompute with the LP-aware formula.
    const newScore = scoreNetPnlRisk({
      priceReturn: outcome.priceReturn,
      feeActiveTvlChange: outcome.feeActiveTvlChange,
      outOfRangeMinutes: outcome.outOfRangeMinutes,
      drawdownPct: outcome.drawdownPct,
      riskFlagsTripped: outcome.riskFlagsTripped,
    });

    out.write(
      JSON.stringify({
        ...outcome,
        netPnlRiskScore: newScore,
        scoreVersion: SCORE_VERSION,
      }) + "\n",
    );
    recomputed++;
  }

  out.end();
  console.log(
    `Recomputed ${recomputed} proxy outcomes, kept ${kept} unchanged → ${outputFile}`,
  );
}

main().catch((err) => {
  console.error("recompute-outcomes failed:", err);
  process.exit(1);
});
