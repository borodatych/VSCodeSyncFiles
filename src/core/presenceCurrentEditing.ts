/**
 * v2.9.4 — pure helpers for the per-machine `currentEditing` presence broadcast.
 *
 * Two privacy modes:
 *   - "full" — write `relPath` literal (default).
 *   - "anonymised" — write `sha256(relPath).slice(0, 8)` so peers can match
 *     "alpha is on the same file as I am" without learning the path.
 *
 * Throttle: when the last broadcast for the same (workspaceId, relPath)
 * happened ≥ `throttleMs` ago, schedule a new write. Otherwise skip.
 */
import { createSha256Provider } from "./hashProviders.js";

export const PRESENCE_THROTTLE_MS = 30_000;

export type CurrentEditingMode = "full" | "anonymised" | "off";

export interface CurrentEditingFrame {
  workspaceId: string;
  relPath: string;
  sinceMs: number;
}

export function buildCurrentEditingFrame(input: {
  workspaceId: string;
  relPath: string;
  nowMs: number;
  mode: CurrentEditingMode;
}): CurrentEditingFrame | null {
  if (input.mode === "off") return null;
  const relPath =
    input.mode === "anonymised"
      ? createSha256Provider().hash(new TextEncoder().encode(input.relPath)).slice(0, 8)
      : input.relPath;
  return { workspaceId: input.workspaceId, relPath, sinceMs: input.nowMs };
}

export interface ShouldBroadcastInput {
  /** Last broadcast frame written by this machine (or null if none yet). */
  last: CurrentEditingFrame | null;
  /** Frame the heartbeat tick wants to broadcast now. */
  next: CurrentEditingFrame | null;
  nowMs: number;
  throttleMs?: number;
}

/** Decide whether a new heartbeat tick must write `next` to _machines.json.
 *
 * Always broadcast when:
 *   - moving idle (`last !== null`) → null,  OR
 *   - moving null → editing,  OR
 *   - the file changed.
 *
 * Throttle when same file is still active.
 */
export function shouldBroadcastCurrentEditing(input: ShouldBroadcastInput): boolean {
  const throttleMs = input.throttleMs ?? PRESENCE_THROTTLE_MS;
  if (input.last === null && input.next === null) return false;
  if ((input.last === null) !== (input.next === null)) return true;
  if (
    input.last &&
    input.next &&
    (input.last.workspaceId !== input.next.workspaceId ||
      input.last.relPath !== input.next.relPath)
  ) {
    return true;
  }
  // Same file — throttle.
  if (input.last && input.nowMs - input.last.sinceMs >= throttleMs) return true;
  return false;
}

/**
 * Compare your own active file against another machine's `currentEditing`
 * frame and produce a pre-conflict risk score 0..1.
 *   - Same workspaceId + same relPath          → 1.0 (concurrent edit certain)
 *   - Same workspaceId, anonymised match (8h)  → 0.8 (likely same file)
 *   - Same workspaceId, different file         → 0.0
 *   - Different workspaceId / null             → 0.0
 */
export function scorePresenceRisk(input: {
  myWorkspaceId: string;
  myRelPath: string;
  myAnonymised?: string;
  peerCurrentEditing: CurrentEditingFrame | null;
}): number {
  const peer = input.peerCurrentEditing;
  if (!peer) return 0;
  if (peer.workspaceId !== input.myWorkspaceId) return 0;
  if (peer.relPath === input.myRelPath) return 1;
  if (input.myAnonymised !== undefined && peer.relPath === input.myAnonymised) return 0.8;
  return 0;
}
