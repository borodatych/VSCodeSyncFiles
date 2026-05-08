/**
 * v2.4.2/3 — pure spawn watchdog state machine for the cloudflared /
 * tailscale tunnel backends. No `child_process`, no timers — caller drives
 * the lifecycle by emitting events; the machine answers with a decision:
 *
 *   onStart()       → "spawn_now"
 *   onSpawned()     → "wait_for_url"
 *   onUrlObserved() → "ready"
 *   onProcessExit() → "respawn_now" | "respawn_after(delayMs)" | "give_up"
 *   onUrlTimeout()  → "respawn_now" | "respawn_after(delayMs)" | "give_up"
 *   onDispose()     → "stop"
 *
 *   States:  idle → spawning → up → respawning → giveup
 *                                ↑________↓
 *
 * Defaults (override-able for tests):
 *   - max attempts before give-up: 3
 *   - exponential backoff: 1 s → 2 s → 4 s (cap 30 s)
 *
 * Discriminated-union state lets the UI render "respawning (#N, retry in X)"
 * without poking into private fields.
 */

export const SPAWN_WATCHDOG_DEFAULT_MAX_ATTEMPTS = 3;
export const SPAWN_WATCHDOG_DEFAULT_INITIAL_DELAY_MS = 1_000;
export const SPAWN_WATCHDOG_DEFAULT_MAX_DELAY_MS = 30_000;
export const SPAWN_WATCHDOG_DEFAULT_BACKOFF_FACTOR = 2;

export type WatchdogState =
  | { kind: "idle" }
  | { kind: "spawning"; attempt: number; sinceMs: number }
  | { kind: "up"; attempt: number; url: string; sinceMs: number }
  | {
      kind: "respawning";
      attempt: number;
      nextDelayMs: number;
      reason: WatchdogFailureReason;
      sinceMs: number;
    }
  | { kind: "giveup"; reason: WatchdogFailureReason; attempts: number; sinceMs: number };

export type WatchdogDecision =
  | { kind: "spawn_now"; attempt: number }
  | { kind: "wait_for_url" }
  | { kind: "ready"; url: string }
  | { kind: "respawn_after"; delayMs: number; attempt: number; reason: WatchdogFailureReason }
  | { kind: "give_up"; reason: WatchdogFailureReason; attempts: number }
  | { kind: "noop" }
  | { kind: "stop" };

export type WatchdogFailureReason =
  | "process_exit"
  | "url_timeout"
  | "spawn_failed";

export interface SpawnWatchdogHandle {
  readonly state: WatchdogState;
  /** Caller wants to start the tunnel. Idempotent if already up/spawning. */
  onStart(nowMs: number): WatchdogDecision;
  /** Caller successfully started the binary; URL not seen yet. */
  onSpawned(nowMs: number): WatchdogDecision;
  /** Caller scraped the public URL from stderr/stdout. */
  onUrlObserved(nowMs: number, url: string): WatchdogDecision;
  /** The watchdog timeout for URL discovery fired. */
  onUrlTimeout(nowMs: number): WatchdogDecision;
  /** Spawn itself failed (binary not on PATH, EACCES, …). */
  onSpawnFailed(nowMs: number): WatchdogDecision;
  /** Process exited (after we saw URL or before). */
  onProcessExit(nowMs: number): WatchdogDecision;
  /** External dispose (workspace deactivate, user disabled tunnel). */
  onDispose(nowMs: number): WatchdogDecision;
}

export interface CreateSpawnWatchdogOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

export function createTunnelSpawnWatchdog(
  opts: CreateSpawnWatchdogOptions = {},
): SpawnWatchdogHandle {
  const cfg = {
    maxAttempts: opts.maxAttempts ?? SPAWN_WATCHDOG_DEFAULT_MAX_ATTEMPTS,
    initialDelayMs: opts.initialDelayMs ?? SPAWN_WATCHDOG_DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs: opts.maxDelayMs ?? SPAWN_WATCHDOG_DEFAULT_MAX_DELAY_MS,
    backoffFactor: opts.backoffFactor ?? SPAWN_WATCHDOG_DEFAULT_BACKOFF_FACTOR,
  };
  if (cfg.maxAttempts < 1) throw new Error("maxAttempts must be >= 1");
  if (cfg.initialDelayMs <= 0) throw new Error("initialDelayMs must be > 0");
  if (cfg.maxDelayMs < cfg.initialDelayMs) {
    throw new Error("maxDelayMs must be >= initialDelayMs");
  }
  if (cfg.backoffFactor < 1) throw new Error("backoffFactor must be >= 1");

  let state: WatchdogState = { kind: "idle" };

  const computeDelay = (attempt: number): number => {
    const exp = cfg.initialDelayMs * Math.pow(cfg.backoffFactor, Math.max(0, attempt - 1));
    return Math.min(cfg.maxDelayMs, Math.floor(exp));
  };

  const handleFailure = (
    nowMs: number,
    reason: WatchdogFailureReason,
  ): WatchdogDecision => {
    const prevAttempt = readAttempt(state);
    if (prevAttempt >= cfg.maxAttempts) {
      state = {
        kind: "giveup",
        reason,
        attempts: prevAttempt,
        sinceMs: nowMs,
      };
      return { kind: "give_up", reason, attempts: prevAttempt };
    }
    const nextAttempt = prevAttempt + 1;
    const delayMs = computeDelay(nextAttempt);
    state = {
      kind: "respawning",
      attempt: nextAttempt,
      nextDelayMs: delayMs,
      reason,
      sinceMs: nowMs,
    };
    return { kind: "respawn_after", delayMs, attempt: nextAttempt, reason };
  };

  return {
    get state(): WatchdogState {
      return state;
    },
    onStart(nowMs): WatchdogDecision {
      if (state.kind === "spawning" || state.kind === "up") {
        return { kind: "noop" };
      }
      const attempt = state.kind === "respawning" ? state.attempt : 1;
      state = { kind: "spawning", attempt, sinceMs: nowMs };
      return { kind: "spawn_now", attempt };
    },
    onSpawned(): WatchdogDecision {
      if (state.kind !== "spawning") return { kind: "noop" };
      return { kind: "wait_for_url" };
    },
    onUrlObserved(nowMs, url): WatchdogDecision {
      if (state.kind !== "spawning") return { kind: "noop" };
      state = { kind: "up", attempt: state.attempt, url, sinceMs: nowMs };
      return { kind: "ready", url };
    },
    onUrlTimeout(nowMs): WatchdogDecision {
      if (state.kind !== "spawning") return { kind: "noop" };
      return handleFailure(nowMs, "url_timeout");
    },
    onSpawnFailed(nowMs): WatchdogDecision {
      if (state.kind !== "spawning") return { kind: "noop" };
      return handleFailure(nowMs, "spawn_failed");
    },
    onProcessExit(nowMs): WatchdogDecision {
      if (state.kind !== "spawning" && state.kind !== "up") return { kind: "noop" };
      return handleFailure(nowMs, "process_exit");
    },
    onDispose(nowMs): WatchdogDecision {
      if (state.kind === "idle") return { kind: "noop" };
      state = { kind: "idle" };
      void nowMs;
      return { kind: "stop" };
    },
  };
}

function readAttempt(state: WatchdogState): number {
  switch (state.kind) {
    case "idle":
      return 0;
    case "spawning":
    case "up":
    case "respawning":
      return state.attempt;
    case "giveup":
      return state.attempts;
  }
}
