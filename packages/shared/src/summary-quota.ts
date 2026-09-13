import { getDraftQuotaWindowStart, getDraftQuotaResetsAt } from "./draft-quota.js";

// Thread-summary limits per plan (AI TL;DRs generated per calendar month, pooled
// per inbox like every other meter). Mirrors THREAD_SORT_LIMITS: every thread a
// plan can sort is a thread it can summarize once. Real spend sits far below the
// cap because empty and automated threads render the stored snippet at
// zero LLM cost, and a cached summary is re-served without regenerating.
// Keep in sync with the plan highlights in packages/shared/src/plans.ts.
export const THREAD_SUMMARY_LIMITS: Record<string, number> = {
  FREE: 50,
  PRO: 5_000,
  BUSINESS: 10_000,
};

export function getThreadSummaryLimit(plan: string): number {
  return THREAD_SUMMARY_LIMITS[plan] ?? THREAD_SUMMARY_LIMITS["FREE"]!;
}

// The summary meter shares the draft meter's calendar-month UTC window. Re-exported
// rather than redefined so the two can never drift.
export const getSummaryQuotaWindowStart = getDraftQuotaWindowStart;
export const getSummaryQuotaResetsAt = getDraftQuotaResetsAt;
