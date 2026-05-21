/**
 * v0.17 N16 — pure decision planner for the network-connectivity probe.
 *
 * Tracks consecutive failures + last success timestamp. After 3 failures
 * within a window (or > 30s since last success) we flip to "offline";
 * after the next success — back to "online". Status bar reads the state
 * and shows an "offline" badge without spamming Activity Feed.
 *
 * No `vscode` import. Caller wires actual fetch(es) to a known-healthy
 * endpoint of the active provider and feeds results in via `note*`.
 */

export type ConnectivityStatus = "online" | "degraded" | "offline" | "unknown";

export interface ConnectivityState {
  status: ConnectivityStatus;
  consecutiveFailures: number;
  /** ms timestamp of the last successful probe. */
  lastSuccessMs: number;
  /** ms timestamp of the last failed probe. */
  lastFailureMs: number;
  /** ms timestamp of the last status transition. */
  lastTransitionMs: number;
}

export interface ConnectivityThresholds {
  /** Consecutive failures before flipping to degraded. Default 2. */
  degradeAfterFailures?: number;
  /** Consecutive failures before flipping to offline. Default 4. */
  offlineAfterFailures?: number;
  /** ms since last success after which "online" decays to "degraded". Default 30s. */
  staleAfterMs?: number;
}

export const INITIAL_STATE: ConnectivityState = {
  status: "unknown",
  consecutiveFailures: 0,
  lastSuccessMs: 0,
  lastFailureMs: 0,
  lastTransitionMs: 0,
};

function thresholds(t: ConnectivityThresholds | undefined): Required<ConnectivityThresholds> {
  return {
    degradeAfterFailures: Math.max(1, t?.degradeAfterFailures ?? 2),
    offlineAfterFailures: Math.max(2, t?.offlineAfterFailures ?? 4),
    staleAfterMs: Math.max(5_000, t?.staleAfterMs ?? 30_000),
  };
}

export function noteProbeSuccess(
  prev: ConnectivityState,
  nowMs: number,
): ConnectivityState {
  const next: ConnectivityState = {
    status: "online",
    consecutiveFailures: 0,
    lastSuccessMs: nowMs,
    lastFailureMs: prev.lastFailureMs,
    lastTransitionMs: prev.status === "online" ? prev.lastTransitionMs : nowMs,
  };
  return next;
}

export function noteProbeFailure(
  prev: ConnectivityState,
  nowMs: number,
  t?: ConnectivityThresholds,
): ConnectivityState {
  const cfg = thresholds(t);
  const failures = prev.consecutiveFailures + 1;
  let status: ConnectivityStatus = prev.status;
  if (failures >= cfg.offlineAfterFailures) status = "offline";
  else if (failures >= cfg.degradeAfterFailures) status = "degraded";
  const lastTransitionMs = status === prev.status ? prev.lastTransitionMs : nowMs;
  return {
    status,
    consecutiveFailures: failures,
    lastSuccessMs: prev.lastSuccessMs,
    lastFailureMs: nowMs,
    lastTransitionMs,
  };
}

/** Apply stale-success decay: if last success > staleAfterMs ago and status
 *  was online, demote to degraded without recording a failure. */
export function decayConnectivity(
  prev: ConnectivityState,
  nowMs: number,
  t?: ConnectivityThresholds,
): ConnectivityState {
  const cfg = thresholds(t);
  if (prev.status !== "online") return prev;
  if (prev.lastSuccessMs === 0) return prev;
  if (nowMs - prev.lastSuccessMs < cfg.staleAfterMs) return prev;
  return {
    ...prev,
    status: "degraded",
    lastTransitionMs: nowMs,
  };
}

/** Should auto-sync attempt skip work right now? Pure decision. */
export function shouldSuppressAutoSync(state: ConnectivityState): boolean {
  return state.status === "offline";
}

/** Human-readable label for the status bar tooltip. */
export function describeConnectivity(state: ConnectivityState, nowMs: number): string {
  switch (state.status) {
    case "online":
      return "Облако: онлайн";
    case "degraded":
      return `Облако: нестабильно (последний успешный пинг ${formatAgo(nowMs - state.lastSuccessMs)} назад)`;
    case "offline":
      return `Облако: оффлайн (${String(state.consecutiveFailures)} ошибок подряд)`;
    case "unknown":
      return "Облако: статус не известен";
  }
}

function formatAgo(ms: number): string {
  if (ms < 0) return "0с";
  if (ms < 60_000) return `${String(Math.floor(ms / 1000))}с`;
  if (ms < 3600_000) return `${String(Math.floor(ms / 60_000))}мин`;
  return `${String(Math.floor(ms / 3600_000))}ч`;
}
