import type { MeteoraActions } from "../tools/meteora-actions.tools.js";
import type { Position } from "../types/index.js";
import { childLogger } from "../utils/logger.js";
import type { PositionTracker } from "./position-tracker.js";

const log = childLogger("cleanup-runner");

export interface CleanupReportClosed {
  positionPubkey: string;
  poolName: string;
  signature?: string;
  reclaimedSol: number;
}

export interface CleanupReportFailed {
  positionPubkey: string;
  poolName: string;
  error: string;
}

export interface CleanupReport {
  scanned: number;
  emptyFound: number;
  closed: CleanupReportClosed[];
  failed: CleanupReportFailed[];
  totalReclaimedSol: number;
  dryRun: boolean;
}

export interface CleanupRunnerOptions {
  tracker: PositionTracker;
  actions: MeteoraActions;
  dryRun?: boolean;
}

/**
 * Identify "phantom" positions in the tracker — those whose on-chain account
 * exists but never received any liquidity — and close them via the DLMM SDK's
 * `closePositionIfEmpty` instruction to reclaim the rent.
 *
 * A position is treated as phantom when ALL of the following hold on the
 * tracker record:
 *   - entryAmountX === "0"
 *   - entryAmountY === "0"
 *   - entryValueUsd === 0
 *
 * These are the markers written by `MeteoraActions.openPosition` when tx#1
 * (createEmptyPosition) succeeded but tx#2 (addLiquidityByStrategy) failed.
 *
 * On successful close: removes the position from the tracker.
 * On failure: keeps the position so the operator can retry.
 */
export class CleanupRunner {
  private readonly tracker: PositionTracker;
  private readonly actions: MeteoraActions;
  private readonly dryRun: boolean;

  constructor(opts: CleanupRunnerOptions) {
    this.tracker = opts.tracker;
    this.actions = opts.actions;
    this.dryRun = opts.dryRun === true;
  }

  async runOnce(): Promise<CleanupReport> {
    const all = this.tracker.listOpen();
    const empties = all.filter(isEmptyPosition);

    log.info(
      { scanned: all.length, emptyFound: empties.length, dryRun: this.dryRun },
      "cleanup scan",
    );

    const closed: CleanupReportClosed[] = [];
    const failed: CleanupReportFailed[] = [];
    let totalReclaimedSol = 0;

    for (const p of empties) {
      try {
        const result = await this.actions.closeEmptyPosition({
          positionPubkey: p.positionPubkey,
          poolAddress: p.poolAddress,
          dryRun: this.dryRun,
        });

        // Only mutate tracker state on real sends. Dry runs report a synthetic
        // signature but leave the on-chain account untouched, so the tracker
        // must keep the entry around for the eventual live cleanup pass.
        if (!this.dryRun) {
          this.tracker.remove(p.positionPubkey);
        }

        closed.push({
          positionPubkey: p.positionPubkey,
          poolName: p.poolName,
          ...(result.signature ? { signature: result.signature } : {}),
          reclaimedSol: result.reclaimedSolEstimate,
        });
        totalReclaimedSol += result.reclaimedSolEstimate;

        log.info(
          {
            position: p.positionPubkey,
            pool: p.poolName,
            signature: result.signature,
            reclaimedSol: result.reclaimedSolEstimate,
            dryRun: this.dryRun,
          },
          "empty position closed",
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // "Position account ... not found" means the on-chain account is
        // already gone (likely closed manually via Meteora UI before this
        // run). Treat as success: remove from tracker so we stop trying.
        const isAlreadyGone =
          /not\s*found|does\s*not\s*exist|account\s*not\s*found/i.test(error);
        if (isAlreadyGone) {
          if (!this.dryRun) {
            this.tracker.remove(p.positionPubkey);
          }
          closed.push({
            positionPubkey: p.positionPubkey,
            poolName: p.poolName,
            reclaimedSol: 0,
          });
          log.info(
            { position: p.positionPubkey, pool: p.poolName },
            "empty position already gone on-chain; removed from tracker",
          );
          continue;
        }

        failed.push({
          positionPubkey: p.positionPubkey,
          poolName: p.poolName,
          error,
        });
        log.warn(
          {
            position: p.positionPubkey,
            pool: p.poolName,
            err: error,
          },
          "empty position close FAILED; left in tracker for retry",
        );
      }
    }

    const report: CleanupReport = {
      scanned: all.length,
      emptyFound: empties.length,
      closed,
      failed,
      totalReclaimedSol,
      dryRun: this.dryRun,
    };

    log.info(
      {
        scanned: report.scanned,
        emptyFound: report.emptyFound,
        closedCount: report.closed.length,
        failedCount: report.failed.length,
        totalReclaimedSol: report.totalReclaimedSol,
        dryRun: report.dryRun,
      },
      "cleanup runOnce complete",
    );

    return report;
  }
}

function isEmptyPosition(p: Position): boolean {
  return (
    p.entryAmountX === "0" && p.entryAmountY === "0" && p.entryValueUsd === 0
  );
}
