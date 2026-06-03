export interface RangeGuidance {
  unit: string;
  formula: string;
  binStep: number;
  targetBinsPerSide: [number, number];
  targetRangeBps: [number, number];
  maxBinsPerSide: number;
  maxRangeBps: number;
}

function targetBinsPerSideFor(binStep: number): [number, number] {
  if (binStep <= 10) return [8, 12];
  if (binStep <= 25) return [6, 10];
  if (binStep <= 50) return [4, 6];
  if (binStep <= 75) return [3, 4];
  return [2, 3];
}

export function rangeGuidanceForBinStep(binStep: number): RangeGuidance {
  const safeBinStep = Number.isFinite(binStep) && binStep > 0 ? binStep : 0;
  const targetBinsPerSide: [number, number] =
    safeBinStep > 0 ? targetBinsPerSideFor(safeBinStep) : [0, 0];
  const [minBinsPerSide, maxBinsPerSide] = targetBinsPerSide;
  const targetRangeBps: [number, number] = [
    Math.round(2 * safeBinStep * minBinsPerSide),
    Math.round(2 * safeBinStep * maxBinsPerSide),
  ];

  return {
    unit: "suggestedRangeBps is total bps span around the active bin",
    formula: "suggestedRangeBps = 2 * binStep * binsPerSide",
    binStep: safeBinStep,
    targetBinsPerSide,
    targetRangeBps,
    maxBinsPerSide,
    maxRangeBps: targetRangeBps[1],
  };
}

export function clampSuggestedRangeBps(
  suggestedRangeBps: number | undefined,
  binStep: number,
): number | undefined {
  if (
    suggestedRangeBps === undefined ||
    !Number.isFinite(suggestedRangeBps) ||
    suggestedRangeBps <= 0
  ) {
    return suggestedRangeBps;
  }

  const guidance = rangeGuidanceForBinStep(binStep);
  if (guidance.maxRangeBps <= 0) return suggestedRangeBps;
  return Math.min(suggestedRangeBps, guidance.maxRangeBps);
}
