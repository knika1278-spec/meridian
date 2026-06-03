import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OKX_PRICE_INFO_PATH,
  okxAdvancedInfoPath,
  okxClusterListPath,
  okxPriceInfoBody,
  okxRiskCheckPath,
  resolveOkxChainIndex,
} from "../okx-web3-endpoints.js";

describe("OKX Web3 endpoint contract", () => {
  it("resolves Solana aliases to OKX chain index 501", () => {
    assert.equal(resolveOkxChainIndex(), "501");
    assert.equal(resolveOkxChainIndex("sol"), "501");
    assert.equal(resolveOkxChainIndex("solana"), "501");
    assert.equal(resolveOkxChainIndex("501"), "501");
  });

  it("builds the OKX paths used by the bot adapter", () => {
    const mint = "Mint With/Chars";

    assert.equal(
      okxAdvancedInfoPath("501", mint),
      "/api/v6/dex/market/token/advanced-info?chainIndex=501&tokenContractAddress=Mint%20With%2FChars",
    );
    assert.equal(
      okxClusterListPath("501", mint),
      "/api/v6/dex/market/token/cluster/list?chainIndex=501&tokenContractAddress=Mint%20With%2FChars",
    );
    assert.equal(
      okxRiskCheckPath("501", mint, 123),
      "/priapi/v1/dx/market/v2/risk/new/check?chainId=501&tokenContractAddress=Mint%20With%2FChars&t=123",
    );
    assert.equal(OKX_PRICE_INFO_PATH, "/api/v6/dex/market/price-info");
    assert.deepEqual(okxPriceInfoBody("501", mint), [
      { chainIndex: "501", tokenContractAddress: mint },
    ]);
  });
});
