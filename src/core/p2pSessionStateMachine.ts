/**
 * v2.1.5 — discriminated-union state machine for one P2P session lifecycle.
 *
 *   Idle → Connecting → Connected → Reconnecting → Disconnected
 *                                ↑________↓
 *
 * The machine tracks:
 *   - Heartbeat liveness (`onHeartbeatTick` / `onHeartbeatReceived`).
 *   - Reconnect attempts with exponential backoff.
 *   - A monotonic event log (`emit`) so the UI can render a recent-activity
 *     view without re-querying the engine.
 *
 * Pure module — no `vscode`, no `setTimeout`. Caller owns the timer; the
 * machine just answers "what's the next delay" and "are we dead".
 */

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_LIVENESS_TIMEOUT_MS = 90_000;
export const RECONNECT_INITIAL_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_BACKOFF_FACTOR = 2;
export const RECONNECT_MAX_ATTEMPTS = 5;

export type P2PSessionState =
  | { kind: "idle" }
  | { kind: "connecting"; sinceMs: number }
  | { kind: "connected"; sinceMs: number; lastHeartbeatAtMs: number }
  | {
      kind: "reconnecting";
      sinceMs: number;
      attempt: number;
      nextDelayMs: number;
    }
  | { kind: "disconnected"; sinceMs: number; reason: string };

export type P2PSessionEvent =
  | { kind: "p2p_session_started"; tsMs: number }
  | { kind: "p2p_session_connected"; tsMs: number }
  | { kind: "p2p_session_heartbeat_received"; tsMs: number }
  | { kind: "p2p_session_heartbeat_lost"; tsMs: number }
  | { kind: "p2p_session_reconnect_scheduled"; tsMs: number; attempt: number; delayMs: number }
  | { kind: "p2p_session_reconnect_giveup"; tsMs: number; reason: string }
  | { kind: "p2p_session_ended"; tsMs: number; reason: string };

export interface SessionMachineHandle {
  state: P2PSessionState;
  events: P2PSessionEvent[];
  start(nowMs: number): void;
  onConnected(nowMs: number): void;
  onHeartbeatReceived(nowMs: number): void;
  /** Caller invokes on a scheduled tick (e.g. every 5 s) to check liveness;
   * returns true when the machine demoted to reconnecting. */
  onHeartbeatTick(nowMs: number): boolean;
  /** Transport reported a disconnect — schedule reconnect or give up. */
  onTransportFailure(nowMs: number, reason: string): void;
  /** Caller successfully reconnected. */
  onReconnectAttemptSucceeded(nowMs: number): void;
  /** Caller manually ended the session. */
  end(nowMs: number, reason: string): void;
}

interface InternalState {
  state: P2PSessionState;
  events: P2PSessionEvent[];
}

export interface CreateSessionMachineOptions {
  /** Override defaults for tests. */
  heartbeatIntervalMs?: number;
  heartbeatLivenessTimeoutMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectBackoffFactor?: number;
  reconnectMaxAttempts?: number;
}

export function createP2PSessionMachine(opts: CreateSessionMachineOptions = {}): SessionMachineHandle {
  const cfg = {
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
    heartbeatLivenessTimeoutMs: opts.heartbeatLivenessTimeoutMs ?? HEARTBEAT_LIVENESS_TIMEOUT_MS,
    reconnectInitialDelayMs: opts.reconnectInitialDelayMs ?? RECONNECT_INITIAL_DELAY_MS,
    reconnectMaxDelayMs: opts.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS,
    reconnectBackoffFactor: opts.reconnectBackoffFactor ?? RECONNECT_BACKOFF_FACTOR,
    reconnectMaxAttempts: opts.reconnectMaxAttempts ?? RECONNECT_MAX_ATTEMPTS,
  };

  const internal: InternalState = {
    state: { kind: "idle" },
    events: [],
  };

  const emit = (e: P2PSessionEvent): void => {
    internal.events.push(e);
  };

  const computeNextDelay = (attempt: number): number => {
    // attempt = 1 → initialDelay; attempt = 2 → initial * factor; …
    const exp = Math.min(
      cfg.reconnectInitialDelayMs * Math.pow(cfg.reconnectBackoffFactor, attempt - 1),
      cfg.reconnectMaxDelayMs,
    );
    return Math.floor(exp);
  };

  return {
    get state(): P2PSessionState {
      return internal.state;
    },
    get events(): P2PSessionEvent[] {
      return internal.events;
    },
    start(nowMs): void {
      if (internal.state.kind !== "idle" && internal.state.kind !== "disconnected") {
        return;
      }
      internal.state = { kind: "connecting", sinceMs: nowMs };
      emit({ kind: "p2p_session_started", tsMs: nowMs });
    },
    onConnected(nowMs): void {
      if (internal.state.kind === "connecting" || internal.state.kind === "reconnecting") {
        internal.state = { kind: "connected", sinceMs: nowMs, lastHeartbeatAtMs: nowMs };
        emit({ kind: "p2p_session_connected", tsMs: nowMs });
      }
    },
    onHeartbeatReceived(nowMs): void {
      if (internal.state.kind === "connected") {
        internal.state = { ...internal.state, lastHeartbeatAtMs: nowMs };
        emit({ kind: "p2p_session_heartbeat_received", tsMs: nowMs });
      }
    },
    onHeartbeatTick(nowMs): boolean {
      if (internal.state.kind !== "connected") return false;
      if (nowMs - internal.state.lastHeartbeatAtMs <= cfg.heartbeatLivenessTimeoutMs) return false;
      // Heartbeat lost — schedule reconnect.
      const attempt = 1;
      const nextDelayMs = computeNextDelay(attempt);
      emit({ kind: "p2p_session_heartbeat_lost", tsMs: nowMs });
      emit({ kind: "p2p_session_reconnect_scheduled", tsMs: nowMs, attempt, delayMs: nextDelayMs });
      internal.state = { kind: "reconnecting", sinceMs: nowMs, attempt, nextDelayMs };
      return true;
    },
    onTransportFailure(nowMs, reason): void {
      if (internal.state.kind === "idle" || internal.state.kind === "disconnected") return;
      const prevAttempt = internal.state.kind === "reconnecting" ? internal.state.attempt : 0;
      const nextAttempt = prevAttempt + 1;
      if (nextAttempt > cfg.reconnectMaxAttempts) {
        internal.state = { kind: "disconnected", sinceMs: nowMs, reason };
        emit({ kind: "p2p_session_reconnect_giveup", tsMs: nowMs, reason });
        emit({ kind: "p2p_session_ended", tsMs: nowMs, reason });
        return;
      }
      const nextDelayMs = computeNextDelay(nextAttempt);
      internal.state = { kind: "reconnecting", sinceMs: nowMs, attempt: nextAttempt, nextDelayMs };
      emit({
        kind: "p2p_session_reconnect_scheduled",
        tsMs: nowMs,
        attempt: nextAttempt,
        delayMs: nextDelayMs,
      });
    },
    onReconnectAttemptSucceeded(nowMs): void {
      if (internal.state.kind === "reconnecting") {
        internal.state = { kind: "connected", sinceMs: nowMs, lastHeartbeatAtMs: nowMs };
        emit({ kind: "p2p_session_connected", tsMs: nowMs });
      }
    },
    end(nowMs, reason): void {
      if (internal.state.kind === "idle" || internal.state.kind === "disconnected") return;
      internal.state = { kind: "disconnected", sinceMs: nowMs, reason };
      emit({ kind: "p2p_session_ended", tsMs: nowMs, reason });
    },
  };
}
