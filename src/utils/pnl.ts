export function finiteNumber(
  value: number | undefined | null,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Normalizes stored or external IL into a positive USD loss. */
export function normalizeIlLossUsd(value: number | undefined | null): number {
  const n = finiteNumber(value);
  return n === undefined ? 0 : Math.abs(n);
}

/** Converts a freshly computed hodl-minus-LP delta into a non-negative IL loss. */
export function computedIlLossUsd(value: number | undefined | null): number {
  const n = finiteNumber(value);
  return n === undefined ? 0 : Math.max(0, n);
}

export function riskAdjustedLegacyPnlUsd(
  realizedPnlUsd: number | undefined | null,
  realizedIlUsd: number | undefined | null,
): number {
  const pnl = finiteNumber(realizedPnlUsd) ?? 0;
  const il = finiteNumber(realizedIlUsd);
  return il !== undefined && il < 0 ? pnl - Math.abs(il) : pnl;
}

export function pnlPctFromUsd(pnlUsd: number, entryValueUsd: number): number {
  return entryValueUsd > 0 && Number.isFinite(entryValueUsd)
    ? pnlUsd / entryValueUsd
    : 0;
}
