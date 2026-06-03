// Deterministic net-PnL-vs-risk score in [-1, +1].
//   Sign convention (consumers depend on it): > 0 = favorable entry, < 0 = toxic, 0 = neutral.
//   shadow-ranker reads `expectedScore < -0.1` (ENTER-was-wrong) and `> 0.2` (SKIP-was-wrong);
//   evidence-index sums `score * weight`; signal-weights derives lift from the sign. Do NOT
//   switch this to a [0,1] range without migrating those consumers.
//
// 1) base:
//    realized → (pnl + fees - il - tx) / max(size,1)   [actual PnL ratio — already correct]
//    proxy    → priceWeight*priceSignal + feeWeight*feeCredit
//               where priceSignal is DIRECTIONAL (crash → strongly negative, pump → positive)
//               and feeCredit is GATED by price health so rug-time fee/volume churn earns ~0.
// 2) subtract out-of-range penalty: min(0.3, 0.1 * floor(outOfRangeMinutes/60)).
// 3) subtract drawdown penalty: min(0.5, 0.5 * drawdownPct).
// 4) subtract risk-flag penalty: min(0.6, 0.2 * riskFlagsTripped.length).
// 5) clamp to [-1, 1]. All undefined/NaN/Infinity inputs coerce to 0.
// Pure: no I/O, no randomness. Same inputs → same output.
import { normalizeIlLossUsd } from "../utils/pnl.js";

// AUDIT FIX [C1]: bumped 2 → 3. The v2 proxy multiplied an UNBOUNDED fee-growth term
// (feeActiveTvlChange, e.g. +32 during a rug) by 0.8, which dwarfed the bounded price
// penalty (max -2.0). Result: tokens that crashed -99% scored ~+0.95 "favorable" because
// fee/volume churn spikes DURING a collapse. v3 makes price directional + dominant and
// gates fee credit by price health. Bumping the version forces recompute-outcomes.ts to
// rescore the corrupted v2 history.
export const SCORE_VERSION = 3;

export interface ProxyWeights {
  /** Weight on the directional price signal. Default 0.8 (price is the dominant signal). */
  priceWeight?: number;
  /** Weight on the (price-gated) fee-growth reward. Default 0.2. */
  feeWeight?: number;
}

// AUDIT FIX [C1]: price is now the dominant, directional driver (0.8) and fee a minor,
// gated reward (0.2) — fee/volume churn can no longer be the primary positive factor.
const DEFAULT_PRICE_WEIGHT = 0.8;
const DEFAULT_FEE_WEIGHT = 0.2;
// feeActiveTvlChange that earns full (1.0) fee credit before gating.
const FEE_NORM = 0.5;
// Positive priceReturn that saturates the upside signal to +1 (e.g. +250% = full credit).
const PRICE_UPSIDE_NORM = 2.5;

export interface ScoreInputs {
  // Realized side (preferred when available)
  realizedPnlUsd?: number;
  realizedFeesUsd?: number;
  realizedIlUsd?: number;
  txCostUsd?: number;
  positionSizeUsd?: number;

  // Market-proxy side (used when no realized data)
  priceReturn?: number;
  feeActiveTvlChange?: number;

  // Optional weight overrides for the proxy formula (defaults applied when absent)
  proxyWeights?: ProxyWeights;

  // Shared penalties
  outOfRangeMinutes?: number;
  drawdownPct?: number;
  riskFlagsTripped?: string[];
}

const safe = (n: number | undefined): number =>
  n === undefined || !Number.isFinite(n) ? 0 : n;

// AUDIT FIX [C1]: directional price signal in [-1, 1].
//   Downside uses sqrt so even moderate drops bite hard:
//     -0.50 → -0.71, -0.80 → -0.89, -0.99 → -0.99 (toxic).
//   Upside saturates so a healthy pump is rewarded but capped:
//     +1.0 → +0.40, +2.5 → +1.0.
function priceSignal(priceReturn: number): number {
  if (priceReturn <= 0) {
    return -Math.sqrt(Math.min(1, -priceReturn));
  }
  return Math.min(1, priceReturn / PRICE_UPSIDE_NORM);
}

/** Returns a deterministic score in [-1, +1]. */
export function scoreNetPnlRisk(inputs: ScoreInputs): number {
  let base: number;
  if (inputs.realizedPnlUsd !== undefined) {
    // Realized PnL is ground truth — it already integrates price, IL and fees. Untouched by [C1].
    const pnl = safe(inputs.realizedPnlUsd);
    const fees = safe(inputs.realizedFeesUsd);
    const il = normalizeIlLossUsd(inputs.realizedIlUsd);
    const tx = safe(inputs.txCostUsd);
    const size = Math.max(safe(inputs.positionSizeUsd), 1);
    base = (pnl + fees - il - tx) / size;
  } else {
    // AUDIT FIX [C1]: LP/entry-quality proxy. Price drives the score; fee growth is a small
    // reward that is GATED by price health — a token that is crashing earns ~no fee credit
    // even if its fee/volume metric spiked, so rugs can no longer score favorable.
    const pw = inputs.proxyWeights?.priceWeight ?? DEFAULT_PRICE_WEIGHT;
    const fw = inputs.proxyWeights?.feeWeight ?? DEFAULT_FEE_WEIGHT;
    const pr = safe(inputs.priceReturn);
    const fat = safe(inputs.feeActiveTvlChange);

    const ps = priceSignal(pr);
    const feeRaw = Math.max(0, Math.min(1, fat / FEE_NORM));
    // priceHealth: 1 when price flat/up, → 0 as price approaches a total loss.
    const priceHealth = Math.max(0, 1 + Math.min(0, pr));
    const feeCredit = feeRaw * priceHealth;

    base = pw * ps + fw * feeCredit;
  }

  const oorMinutes = safe(inputs.outOfRangeMinutes);
  const oorPenalty = Math.min(0.3, 0.1 * Math.floor(oorMinutes / 60));

  const ddPenalty = Math.min(0.5, 0.5 * safe(inputs.drawdownPct));

  const flagCount = inputs.riskFlagsTripped?.length ?? 0;
  const flagPenalty = Math.min(0.6, 0.2 * flagCount);

  const raw = base - oorPenalty - ddPenalty - flagPenalty;
  return Math.max(-1, Math.min(1, raw));
}
