// Outcome collector orchestrator: glues scheduler + entry/realized computers
// into a single cycle. Pulls due decisions, computes outcomes via the
// appropriate computer (screener -> entry, manager -> realized), appends
// to outcomes store, and reports counts. Never throws upward.

import type { LearningOutcome } from "../types/index.js";
import type { JsonlStore } from "./jsonl-store.js";
import type { OutcomeScheduler } from "./outcome-scheduler.js";
import type { EntryOutcomeComputer } from "./entry-outcome.js";
import type { RealizedOutcomeComputer } from "./realized-outcome.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("outcome-collector");

const DEFAULT_MAX_PER_CYCLE = 20;

export interface OutcomeCollectorOptions {
  scheduler: OutcomeScheduler;
  entryComputer: EntryOutcomeComputer;
  realizedComputer: RealizedOutcomeComputer;
  outcomesStore: JsonlStore<LearningOutcome & Record<string, unknown>>;
  maxPerCycle?: number;
}

export interface OutcomeCollectorResult {
  labeled: number;
  skipped: number;
  errors: number;
}

export class OutcomeCollector {
  private readonly scheduler: OutcomeScheduler;
  private readonly entryComputer: EntryOutcomeComputer;
  private readonly realizedComputer: RealizedOutcomeComputer;
  private readonly outcomesStore: JsonlStore<
    LearningOutcome & Record<string, unknown>
  >;
  private readonly maxPerCycle: number;

  constructor(opts: OutcomeCollectorOptions) {
    this.scheduler = opts.scheduler;
    this.entryComputer = opts.entryComputer;
    this.realizedComputer = opts.realizedComputer;
    this.outcomesStore = opts.outcomesStore;
    this.maxPerCycle = opts.maxPerCycle ?? DEFAULT_MAX_PER_CYCLE;
  }

  async runDue(now?: number): Promise<OutcomeCollectorResult> {
    const due = this.scheduler.findDue(now).slice(0, this.maxPerCycle);

    let labeled = 0;
    const skipped = 0;
    let errors = 0;

    for (const { decision, horizonMinutes } of due) {
      try {
        const outcome =
          decision.kind === "screener"
            ? await this.entryComputer.compute(decision, horizonMinutes)
            : await this.realizedComputer.compute(decision, horizonMinutes);
        this.outcomesStore.append(
          outcome as LearningOutcome & Record<string, unknown>,
        );
        labeled++;
      } catch (err: unknown) {
        log.warn(
          { err, decisionId: decision.id, horizonMinutes },
          "outcome computer failed",
        );
        errors++;
      }
    }

    log.info(
      { labeled, skipped, errors, total: due.length },
      "outcome collector cycle done",
    );

    return { labeled, skipped, errors };
  }
}
