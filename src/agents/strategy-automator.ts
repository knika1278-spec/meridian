import type { Position, StrategyAutomationConfig } from "../types/index.js";
import { logger } from "../utils/logger.js";

export type AutomatorAction =
  | { kind: "none" }
  | { kind: "harvest"; claimableUsd: number }
  | { kind: "compound"; claimableUsd: number }
  | { kind: "reseed"; pnlPct: number };

export interface AutomatorResult {
  action: AutomatorAction;
  updatedPosition: Position;
}

/**
 * Evaluates a position against the strategy automation config and returns the
 * recommended action plus the updated Position with timestamp fields set.
 *
 * Callers are responsible for actually executing the on-chain side-effect
 * (via meteora-actions) and persisting the returned updatedPosition.
 */
export function evaluateStrategyAutomation(
  position: Position,
  config: StrategyAutomationConfig,
  claimableUsd: number,
  pnlPct: number,
  dryRun: boolean,
): AutomatorResult {
  const now = Date.now();
  let action: AutomatorAction = { kind: "none" };
  let updatedPosition = { ...position };

  // Reseed takes precedence over compound: it closes and reopens.
  if (
    config.autoReseed &&
    typeof config.reseedMinPnlPct === "number" &&
    pnlPct >= config.reseedMinPnlPct
  ) {
    action = { kind: "reseed", pnlPct };
    updatedPosition = { ...updatedPosition, lastReseedAt: now };
    logger.info(
      {
        positionId: position.poolAddress,
        pnlPct,
        reseedMinPnlPct: config.reseedMinPnlPct,
        dryRun,
      },
      "strategy-automator: reseed triggered",
    );
    return { action, updatedPosition };
  }

  // Compound: claim + add fees back into position.
  if (
    config.autoCompound &&
    typeof config.compoundMinUsd === "number" &&
    claimableUsd >= config.compoundMinUsd
  ) {
    action = { kind: "compound", claimableUsd };
    updatedPosition = { ...updatedPosition, lastCompoundAt: now };
    logger.info(
      {
        positionId: position.poolAddress,
        claimableUsd,
        compoundMinUsd: config.compoundMinUsd,
        dryRun,
      },
      "strategy-automator: compound triggered",
    );
    return { action, updatedPosition };
  }

  // Harvest: claim only (no reinvestment).
  if (
    config.autoHarvest &&
    typeof config.harvestMinUsd === "number" &&
    claimableUsd >= config.harvestMinUsd
  ) {
    action = { kind: "harvest", claimableUsd };
    updatedPosition = { ...updatedPosition, lastHarvestAt: now };
    logger.info(
      {
        positionId: position.poolAddress,
        claimableUsd,
        harvestMinUsd: config.harvestMinUsd,
        dryRun,
      },
      "strategy-automator: harvest triggered",
    );
    return { action, updatedPosition };
  }

  return { action: { kind: "none" }, updatedPosition };
}
