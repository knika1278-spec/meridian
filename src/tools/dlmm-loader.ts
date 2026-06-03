import { createRequire } from "node:module";

/**
 * Loads the `@meteora-ag/dlmm` SDK via CJS resolution instead of ESM.
 *
 * Why: `@meteora-ag/dlmm@^1.9` ships a dual ESM/CJS build, and its `.mjs`
 * entry transitively imports `@coral-xyz/anchor@0.31+` which uses
 * directory imports under `.../utils/bytes`. Node refuses directory imports
 * from ESM context, throwing:
 *
 *   ERR_UNSUPPORTED_DIR_IMPORT: Directory import '...anchor/dist/cjs/utils/bytes'
 *   is not supported resolving ES modules
 *
 * CJS resolution does not enforce that restriction, so `createRequire` lets
 * us load the SDK cleanly from our ESM project.
 *
 * Cached after the first call.
 */

interface DlmmModuleShape {
  default?: unknown;
  DLMM?: unknown;
  StrategyType?: unknown;
  [key: string]: unknown;
}

const requireCjs = createRequire(import.meta.url);

let cached: DlmmModuleShape | null = null;

export function loadDlmmSdk(): DlmmModuleShape {
  if (cached) return cached;
  const mod = requireCjs("@meteora-ag/dlmm") as DlmmModuleShape;
  cached = mod;
  return mod;
}
