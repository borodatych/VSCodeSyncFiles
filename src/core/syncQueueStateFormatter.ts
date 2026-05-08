/**
 * Cross-cutting — pure formatter that turns a snapshot of `RequestQueue`
 * state (per-provider) into UI-renderable rows for diagnostics commands
 * like `vscodesync.showQueueState`.
 *
 * The formatter does not import `RequestQueue` directly so the `core`
 * module stays free of any side-effecting class instances; caller takes
 * the snapshot and passes plain numbers in.
 *
 * No `vscode` import.
 */

import type { ProviderType } from "./types.js";

export interface QueueProviderSnapshot {
  provider: ProviderType;
  /** Operations currently running. */
  activeCount: number;
  /** Operations queued but not yet running. */
  pendingCount: number;
  /** Optional: ms timestamp of when the oldest pending operation was
   * enqueued. UI can render "Oldest: 12s ago" if non-null. */
  oldestPendingAtMs?: number | null;
}

export interface QueueStateRow {
  provider: ProviderType;
  label: string;
  description: string;
  detail: string;
  /** Health classification — drives icon / color selection in the UI. */
  health: QueueHealth;
}

export type QueueHealth = "idle" | "active" | "backed_up" | "stalled";

export interface FormatQueueStateOptions {
  /** Pending count above which the queue is classified `backed_up`. */
  backedUpThreshold?: number;
  /** ms age of the oldest pending op above which the queue is classified
   * `stalled`. Default 60s. */
  stalledOldestMs?: number;
  /** Caller "now" (ms) — needed for the stalled detection. */
  nowMs: number;
}

const DEFAULT_BACKED_UP_THRESHOLD = 5;
const DEFAULT_STALLED_OLDEST_MS = 60_000;

export function formatQueueState(
  snapshots: readonly QueueProviderSnapshot[],
  options: FormatQueueStateOptions,
): QueueStateRow[] {
  const backedUpThreshold = options.backedUpThreshold ?? DEFAULT_BACKED_UP_THRESHOLD;
  const stalledMs = options.stalledOldestMs ?? DEFAULT_STALLED_OLDEST_MS;

  return snapshots.map<QueueStateRow>((s) => {
    const health = classifyHealth({
      snapshot: s,
      backedUpThreshold,
      stalledMs,
      nowMs: options.nowMs,
    });
    return {
      provider: s.provider,
      label: s.provider,
      description: renderDescription(s),
      detail: renderDetail(s, options.nowMs),
      health,
    };
  });
}

function classifyHealth(args: {
  snapshot: QueueProviderSnapshot;
  backedUpThreshold: number;
  stalledMs: number;
  nowMs: number;
}): QueueHealth {
  const { snapshot: s, backedUpThreshold, stalledMs, nowMs } = args;
  if (s.activeCount === 0 && s.pendingCount === 0) return "idle";
  if (
    s.oldestPendingAtMs !== undefined &&
    s.oldestPendingAtMs !== null &&
    nowMs - s.oldestPendingAtMs >= stalledMs
  ) {
    return "stalled";
  }
  if (s.pendingCount >= backedUpThreshold) return "backed_up";
  return "active";
}

function renderDescription(s: QueueProviderSnapshot): string {
  return `active=${String(s.activeCount)} · pending=${String(s.pendingCount)}`;
}

function renderDetail(s: QueueProviderSnapshot, nowMs: number): string {
  if (s.oldestPendingAtMs === undefined || s.oldestPendingAtMs === null) {
    return s.pendingCount === 0 ? "Queue idle." : "Oldest pending: unknown";
  }
  const ageMs = Math.max(0, nowMs - s.oldestPendingAtMs);
  return `Oldest pending: ${formatRelative(ageMs)} ago`;
}

function formatRelative(ageMs: number): string {
  if (ageMs < 1000) return `${String(Math.round(ageMs / 100) * 100)}ms`;
  if (ageMs < 60_000) return `${String(Math.round(ageMs / 1000))}s`;
  if (ageMs < 60 * 60_000) {
    const m = Math.floor(ageMs / 60_000);
    const s = Math.floor((ageMs % 60_000) / 1000);
    return s > 0 ? `${String(m)}m ${String(s)}s` : `${String(m)}m`;
  }
  const h = Math.floor(ageMs / (60 * 60_000));
  const m = Math.floor((ageMs % (60 * 60_000)) / 60_000);
  return m > 0 ? `${String(h)}h ${String(m)}m` : `${String(h)}h`;
}
