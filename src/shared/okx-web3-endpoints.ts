export const OKX_SOLANA_CHAIN_INDEX = "501";

export const OKX_PRICE_INFO_PATH = "/api/v6/dex/market/price-info";

export interface OkxPriceInfoRequestItem {
  chainIndex: string;
  tokenContractAddress: string;
}

export function resolveOkxChainIndex(chainShortName?: string): string {
  const v = (chainShortName ?? "sol").trim().toLowerCase();
  if (/^\d+$/.test(v)) return v;
  if (v === "sol" || v === "solana") return OKX_SOLANA_CHAIN_INDEX;
  return v;
}

export function okxAdvancedInfoPath(chainIndex: string, mint: string): string {
  return `/api/v6/dex/market/token/advanced-info?chainIndex=${encodeURIComponent(
    chainIndex,
  )}&tokenContractAddress=${encodeURIComponent(mint)}`;
}

export function okxRiskCheckPath(
  chainIndex: string,
  mint: string,
  timestampMs = Date.now(),
): string {
  return `/priapi/v1/dx/market/v2/risk/new/check?chainId=${encodeURIComponent(
    chainIndex,
  )}&tokenContractAddress=${encodeURIComponent(mint)}&t=${timestampMs}`;
}

export function okxClusterListPath(chainIndex: string, mint: string): string {
  return `/api/v6/dex/market/token/cluster/list?chainIndex=${encodeURIComponent(
    chainIndex,
  )}&tokenContractAddress=${encodeURIComponent(mint)}`;
}

export function okxPriceInfoBody(
  chainIndex: string,
  mint: string,
): OkxPriceInfoRequestItem[] {
  return [{ chainIndex, tokenContractAddress: mint }];
}
