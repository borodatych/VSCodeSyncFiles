/**
 * U3 — Undoable destructive actions — pure registry.
 *
 * Skeleton: an in-memory ring of the last N user-initiated destructive
 * ops (delete workspace, purge encrypted bundle, force-detach). UI layer
 * exposes a Quick Pick of pending undos with a per-entry undo button;
 * each entry holds a structured payload + an `undoTag` the engine knows
 * how to revert.
 *
 * Pure module — no engine access, no vscode imports. UI commits
 * `register()` immediately after the destructive op succeeds; before the
 * TTL expires the user can pick the entry and the UI calls into the
 * appropriate engine method.
 */

export interface UndoableEntry {
  /** Discriminator the engine matches on. */
  undoTag:
    | "delete_workspace_cloud"
    | "delete_workspace_local"
    | "purge_encrypted_bundle"
    | "force_detach";
  /** Free-form summary for the Quick Pick. */
  summary: string;
  /** Opaque payload — receiver casts based on undoTag. */
  payload: Record<string, unknown>;
  /** Time the action was registered. */
  registeredAtMs: number;
  /** Window (ms) during which the entry is selectable. */
  ttlMs: number;
}

export interface UndoableRegistrySnapshot {
  /** Entries currently selectable (TTL not expired). */
  active: UndoableEntry[];
  /** Entries discarded because TTL ran out. */
  expired: UndoableEntry[];
}

const DEFAULT_RING_SIZE = 8;
const DEFAULT_TTL_MS = 60_000;

export class UndoableActionRegistry {
  private readonly buf: UndoableEntry[] = [];
  constructor(private readonly ringSize = DEFAULT_RING_SIZE) {}

  register(input: Omit<UndoableEntry, "registeredAtMs" | "ttlMs"> & { ttlMs?: number }): UndoableEntry {
    const entry: UndoableEntry = {
      undoTag: input.undoTag,
      summary: input.summary,
      payload: input.payload,
      registeredAtMs: Date.now(),
      ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
    };
    this.buf.unshift(entry);
    if (this.buf.length > this.ringSize) this.buf.length = this.ringSize;
    return entry;
  }

  snapshot(nowMs: number = Date.now()): UndoableRegistrySnapshot {
    const active: UndoableEntry[] = [];
    const expired: UndoableEntry[] = [];
    for (const e of this.buf) {
      (nowMs - e.registeredAtMs <= e.ttlMs ? active : expired).push(e);
    }
    return { active, expired };
  }

  consume(entry: UndoableEntry): boolean {
    const ix = this.buf.indexOf(entry);
    if (ix < 0) return false;
    this.buf.splice(ix, 1);
    return true;
  }
}
