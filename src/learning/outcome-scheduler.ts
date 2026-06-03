import type { LearningDecision, LearningOutcome } from "../types/index.js";
import type { JsonlStore } from "./jsonl-store.js";

type DecisionStore = JsonlStore<LearningDecision & Record<string, unknown>>;
type OutcomeStore = JsonlStore<LearningOutcome & Record<string, unknown>>;

export interface DueDecision {
  decision: LearningDecision;
  horizonMinutes: number;
}

export interface OutcomeSchedulerOptions {
  decisionsStore: DecisionStore;
  outcomesStore: OutcomeStore;
  horizons: number[];
}

export class OutcomeScheduler {
  private readonly decisionsStore: DecisionStore;
  private readonly outcomesStore: OutcomeStore;
  private readonly horizons: number[];

  constructor(opts: OutcomeSchedulerOptions) {
    this.decisionsStore = opts.decisionsStore;
    this.outcomesStore = opts.outcomesStore;
    this.horizons = opts.horizons;
  }

  findDue(now: number = Date.now()): DueDecision[] {
    const outcomes = this.outcomesStore.readAll();
    const seen = new Set<string>();
    for (const outcome of outcomes) {
      seen.add(`${outcome.decisionId}|${outcome.horizonMinutes}`);
    }

    const decisions = this.decisionsStore.readAll();
    const due: DueDecision[] = [];

    for (const decision of decisions) {
      for (const horizon of this.horizons) {
        if (now - decision.timestamp < horizon * 60_000) continue;
        if (seen.has(`${decision.id}|${horizon}`)) continue;
        due.push({ decision, horizonMinutes: horizon });
      }
    }

    return due;
  }
}
