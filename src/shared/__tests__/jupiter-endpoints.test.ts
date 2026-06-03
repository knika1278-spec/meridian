import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  JUPITER_PRICE_PATH,
  JUPITER_TOKEN_SEARCH_PATH,
  jupiterPriceParams,
  jupiterTokenSearchParams,
  normalizeJupiterBaseUrl,
} from "../jupiter-endpoints.js";

describe("Jupiter endpoint contract", () => {
  it("normalizes paid-tier base URL and exposes request paths", () => {
    assert.equal(
      normalizeJupiterBaseUrl("https://lite-api.jup.ag/", true),
      "https://api.jup.ag",
    );
    assert.equal(
      normalizeJupiterBaseUrl("https://lite-api.jup.ag/", false),
      "https://lite-api.jup.ag",
    );
    assert.equal(JUPITER_TOKEN_SEARCH_PATH, "/tokens/v2/search");
    assert.equal(JUPITER_PRICE_PATH, "/price/v3");
    assert.deepEqual(jupiterTokenSearchParams("mint"), { query: "mint" });
    assert.deepEqual(jupiterPriceParams(["a", "b"]), { ids: "a,b" });
  });
});
