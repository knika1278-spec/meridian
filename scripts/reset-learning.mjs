#!/usr/bin/env node
// Reset the learning loop to a clean slate after the PHASE-1.5 entry-outcome fix.
// The pre-fix learning-outcomes rows have a bad priceReturn baseline (cross-API
// price-basis mismatch) that recompute-outcomes.ts cannot salvage, so the only
// correct action is to wipe the derived data and let it rebuild from new decisions.
//
// Safe & idempotent: backs up every touched file into <dataDir>/backup-phase15-<ts>/
// before truncating. Never touches positions.json / closed-positions.json.
//
//   node scripts/reset-learning.mjs            # uses output.dataDir from user-config.json
//   node scripts/reset-learning.mjs ./data     # explicit data dir

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveDataDir() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(root, "src/config/user-config.json"), "utf8"),
    );
    const dir = cfg?.output?.dataDir;
    if (typeof dir === "string" && dir.length > 0) return path.resolve(root, dir);
  } catch {
    // fall through to default
  }
  return path.resolve(root, "data");
}

const dataDir = resolveDataDir();
if (!fs.existsSync(dataDir)) {
  console.error(`data dir not found: ${dataDir}`);
  process.exit(1);
}

// Empty (truncate) — corrupt or derived-from-corrupt learning state.
const EMPTY_FILES = [
  "learning-outcomes.jsonl",
  "shadow-scores.jsonl",
  "learning-lessons.jsonl",
  "learning-snapshot.jsonl",
  "learning-decisions.jsonl",
];
// Reset to a known baseline rather than empty.
const BASELINE_FILES = {
  "signal-weights.json":
    '{"generatedAt":0,"sampleSize":0,"minSamples":5,"topPositive":[],"topNegative":[]}\n',
  "lessons.json": "[]\n",
};

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 15);
const backupDir = path.join(dataDir, `backup-phase15-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });

const allFiles = [...EMPTY_FILES, ...Object.keys(BASELINE_FILES)];
let backed = 0;
for (const f of allFiles) {
  const src = path.join(dataDir, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(backupDir, f));
    backed++;
  }
}
console.log(`backed up ${backed} file(s) -> ${backupDir}`);

for (const f of EMPTY_FILES) {
  fs.writeFileSync(path.join(dataDir, f), "");
  console.log(`emptied   ${f}`);
}
for (const [f, content] of Object.entries(BASELINE_FILES)) {
  fs.writeFileSync(path.join(dataDir, f), content);
  console.log(`baseline  ${f}`);
}

console.log("\nlearning reset complete. restart the bot to rebuild from new decisions.");
