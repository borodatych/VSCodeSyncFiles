/**
 * v2.1.3 — pure auto-disconnect tracker for an active P2P session.
 *
 * Caller emits `noteFrame(nowMs)` for every inbound or outbound frame
 * (heartbeat, manifest payload, file chunk). On a periodic tick the caller
 * asks `evaluate(nowMs)` and acts on the returned decision:
 *
 *   - "continue" — session is fresh enough, keep going.
 *   - "warn"     — idle window is past the warning threshold but still under
 *                  the disconnect threshold; UI may surface a "P2P idle"
 *                  status hint. Idempotent within one idle window.
 *   - "disconnect" — idle window crossed `disconnectAfterMs`; caller must
 *                  tear down the channel. Idempotent within one idle window.
 *
 * The tracker is a discriminated-union state machine; no `vscode`, no
 * timers. Defaults match the v2 spec: 5 minutes idle = disconnect, with a
 * 4-minute warning preview.
 */

export const P2P_IDLE_DEFAULT_DISCONNECT_MS = 5 * 60 * 1000;
export const P2P_IDLE_DEFAULT_WARN_MS = 4 * 60 * 1000;

export type IdleDecision = "continue" | "warn" | "disconnect";

export type IdleTrackerState =
  | { kind: "fresh"; lastFrameAtMs: number }
  | { kind: "warned"; lastFrameAtMs: number; warnedAtMs: number }
  | { kind: "disconnected"; lastFrameAtMs: number; disconnectedAtMs: number };

export interface IdleTrackerHandle {
  readonly state: IdleTrackerState;
  /** Should be called for every frame the channel observes. Resets the idle
   *  clock and re-arms warn/disconnect for the next window. */
  noteFrame(nowMs: number): void;
  /** Tick check. Returns the decision and may transition the state. After a
   *  `disconnect` decision is emitted once, subsequent ticks return
   *  `continue` until the next `noteFrame()` resets the cycle. */
  evaluate(nowMs: number): IdleDecision;
  /** Returns the configured threshold in ms (for UI tooltip). */
  readonly disconnectAfterMs: number;
  readonly warnAfterMs: number;
}

export interface CreateIdleTrackerOptions {
  /** When set, overrides the 5-minute disconnect threshold. */
  disconnectAfterMs?: number;
  /** When set, overrides the 4-minute warn threshold. Must be < disconnectAfterMs. */
  warnAfterMs?: number;
  /** Seed `lastFrameAtMs` so the tracker starts "as if a frame just arrived". */
  startAtMs?: number;
}

export function createP2PIdleTracker(
  opts: CreateIdleTrackerOptions = {},
): IdleTrackerHandle {
  const disconnectAfterMs = opts.disconnectAfterMs ?? P2P_IDLE_DEFAULT_DISCONNECT_MS;
  const warnAfterMs = opts.warnAfterMs ?? P2P_IDLE_DEFAULT_WARN_MS;
  if (disconnectAfterMs <= 0) {
    throw new Error("disconnectAfterMs must be positive");
  }
  if (warnAfterMs <= 0 || warnAfterMs >= disconnectAfterMs) {
    throw new Error("warnAfterMs must be > 0 and < disconnectAfterMs");
  }

  let state: IdleTrackerState = {
    kind: "fresh",
    lastFrameAtMs: opts.startAtMs ?? 0,
  };

  return {
    get state(): IdleTrackerState {
      return state;
    },
    get disconnectAfterMs(): number {
      return disconnectAfterMs;
    },
    get warnAfterMs(): number {
      return warnAfterMs;
    },
    noteFrame(nowMs): void {
      state = { kind: "fresh", lastFrameAtMs: nowMs };
    },
    evaluate(nowMs): IdleDecision {
      const idleMs = nowMs - state.lastFrameAtMs;
      if (idleMs >= disconnectAfterMs) {
        if (state.kind === "disconnected") return "continue";
        state = { kind: "disconnected", lastFrameAtMs: state.lastFrameAtMs, disconnectedAtMs: nowMs };
        return "disconnect";
      }
      if (idleMs >= warnAfterMs) {
        if (state.kind === "warned" || state.kind === "disconnected") return "continue";
        state = { kind: "warned", lastFrameAtMs: state.lastFrameAtMs, warnedAtMs: nowMs };
        return "warn";
      }
      return "continue";
    },
  };
}
