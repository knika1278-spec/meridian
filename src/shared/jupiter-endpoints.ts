export const JUPITER_TOKEN_SEARCH_PATH = "/tokens/v2/search";
export const JUPITER_PRICE_PATH = "/price/v3";

export function normalizeJupiterBaseUrl(
  rawBaseUrl: string,
  usePaidTier: boolean,
): string {
  let baseUrl = rawBaseUrl.replace(/\/+$/, "");
  if (usePaidTier && baseUrl.includes("lite-api.jup.ag")) {
    baseUrl = baseUrl.replace("lite-api.jup.ag", "api.jup.ag");
  }
  return baseUrl;
}

export function jupiterTokenSearchParams(mint: string): { query: string } {
  return { query: mint };
}

export function jupiterPriceParams(mints: string[]): { ids: string } {
  return { ids: mints.join(",") };
}
