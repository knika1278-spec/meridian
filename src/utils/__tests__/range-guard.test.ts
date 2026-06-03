import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clampSuggestedRangeBps,
  rangeGuidanceForBinStep,
} from "../range-guard.js";

describe("range guard", () => {
  it("targets 2-3 bins per side for binStep 100", () => {
    const guidance = rangeGuidanceForBinStep(100);

    assert.deepEqual(guidance.targetBinsPerSide, [2, 3]);
    assert.deepEqual(guidance.targetRangeBps, [400, 600]);
    assert.equal(guidance.maxRangeBps, 600);
  });

  it("clamps very wide LLM suggestions for volatile bins", () => {
    assert.equal(clampSuggestedRangeBps(2000, 100), 600);
    assert.equal(clampSuggestedRangeBps(1200, 125), 750);
  });

  it("allows more bins for smaller bin steps without broadening too far", () => {
    const guidance = rangeGuidanceForBinStep(50);

    assert.deepEqual(guidance.targetBinsPerSide, [4, 6]);
    assert.deepEqual(guidance.targetRangeBps, [400, 600]);
    assert.equal(clampSuggestedRangeBps(700, 50), 600);
  });

  it("leaves absent or invalid suggestions alone", () => {
    assert.equal(clampSuggestedRangeBps(undefined, 100), undefined);
    assert.equal(clampSuggestedRangeBps(0, 100), 0);
    assert.equal(clampSuggestedRangeBps(1200, 0), 1200);
  });
});
