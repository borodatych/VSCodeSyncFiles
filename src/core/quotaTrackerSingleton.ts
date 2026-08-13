/**
 * One tracker for the whole window.
 *
 * Provider API usage is a per-process fact: every engine instance (one per
 * workspace folder, rebuilt on every command) talks to the same cloud account
 * against the same daily budget. A tracker owned by the engine factory would
 * reset its window on each rebuild and always report near-zero usage — the
 * dashboard would be decorative.
 */
import { createQuotaTracker, type QuotaTracker } from "./quotaTracker.js";

let instance: QuotaTracker | undefined;

export function sharedQuotaTracker(): QuotaTracker {
  instance ??= createQuotaTracker();
  return instance;
}

/** Test seam. */
export function resetSharedQuotaTracker(): void {
  instance = undefined;
}
