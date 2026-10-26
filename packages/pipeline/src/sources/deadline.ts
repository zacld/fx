/**
 * sources/deadline.ts — time limits shared by the slow enrichment stages.
 *
 * Each stage has its own budget (FX_DM_BUDGET_MIN, FX_INTEL_BUDGET_MIN), but
 * those count from the stage's own start. The workflow also sets
 * FX_PIPELINE_DEADLINE (unix seconds) for the whole `npm run pipeline` step,
 * so a slow discover or enrich-contacts can't push the later stages (score,
 * dedup, export) past the step's limit: each stage stops early enough to
 * leave `reserveMinutes` for what comes after it.
 */

/** When a stage must stop starting new work: its own budget, or earlier to leave room before the pipeline's end. */
export function stageDeadline(budgetMinutes: number, reserveMinutes: number, now = Date.now()): number {
  const own = now + budgetMinutes * 60_000;
  const end = Number(process.env.FX_PIPELINE_DEADLINE ?? 0) * 1000;
  return end > 0 ? Math.min(own, end - reserveMinutes * 60_000) : own;
}

/** Set when a lead is given up on, so its unfinished work stops at the next step instead of running on. */
export interface StopFlag { stopped: boolean }

/** A fetcher that answers nothing once `stop` is set (no new requests for a lead given up on). */
export function stoppable<A extends unknown[], R>(fn: (...args: A) => Promise<R | null>, stop: StopFlag) {
  return (...args: A): Promise<R | null> => (stop.stopped ? Promise.resolve(null) : fn(...args));
}
