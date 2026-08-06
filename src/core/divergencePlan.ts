/**
 * The divergence list, as data (stage 3.5).
 *
 * The panel that replaces the removed `full` auto-sync mode needs one thing:
 * what differs between this machine and the cloud, grouped so a person can act
 * on it. That answer is already sitting in `syncStatus` — the detector writes
 * it on every background pass using conditional GETs, and it is the only thing
 * a background pass is allowed to write.
 *
 * Deliberately *not* built on `previewSyncPlan`: that method downloads the full
 * body of every tracked file to recompute the cloud hash, with no
 * `ifNoneMatch`. For a workspace of N files that is N full downloads every
 * time the panel opens — the panel would be the most expensive screen in the
 * extension while showing what the detector already knew for free.
 *
 * Pure: no `vscode`, no I/O. Callers load the per-root configs and pass them in.
 */
import type { ActiveWorkspaceEntry, TrackedFile, WorkspaceConfig } from "./types.js";
import { normalizeWorkspaceSyncState } from "./types.js";

/** Which way the file wants to move, from this machine's point of view. */
export type DivergenceDirection = "push" | "pull" | "conflict";

export interface DivergenceRow {
  /** Workspace folder root on disk — rows from several roots share one list. */
  root: string;
  workspaceId: string;
  posixRel: string;
  direction: DivergenceDirection;
  /** Short human-readable cause, shown in the row. */
  reason: string;
  /** Machine holding a soft lock on the file, when known. */
  editingByName?: string;
}

export interface DivergenceGroup {
  root: string;
  workspaceId: string;
  workspaceNote: string;
  /** Suspended and frozen workspaces still show, marked — hiding them would
   *  make "why is nothing happening" unanswerable from the panel. */
  suspended: boolean;
  rows: DivergenceRow[];
}

export interface DivergenceCounts {
  push: number;
  pull: number;
  conflict: number;
  total: number;
}

export interface DivergenceRootInput {
  root: string;
  cfg: WorkspaceConfig;
}

/** Panel filter chips. `all` keeps every row. */
export type DivergenceFilter = "all" | DivergenceDirection;

function directionOf(file: TrackedFile): DivergenceDirection | null {
  switch (file.syncStatus) {
    case "conflict":
      return "conflict";
    case "cloud_newer":
      return "pull";
    case "pending_push":
      return "push";
    default:
      // "ok" and files the detector has not classified yet are not divergences.
      return null;
  }
}

function reasonOf(direction: DivergenceDirection, file: TrackedFile): string {
  switch (direction) {
    case "conflict":
      return "изменён и здесь, и в облаке";
    case "pull":
      return file.localHash === ""
        ? "есть в облаке, нет локально"
        : "в облаке новее";
    case "push":
      return "изменён локально";
  }
}

function noteFor(entry: ActiveWorkspaceEntry): string {
  return entry.workspaceNote.trim() || entry.workspaceId.slice(0, 8);
}

/**
 * Group divergent files by workspace, across every open root.
 *
 * Groups with no divergences are dropped; groups are ordered by note, rows by
 * path — the panel must not reshuffle under the user between refreshes.
 */
export function buildDivergencePlan(inputs: readonly DivergenceRootInput[]): DivergenceGroup[] {
  const groups: DivergenceGroup[] = [];
  for (const { root, cfg } of inputs) {
    for (const entry of cfg.activeWorkspaces) {
      const rows: DivergenceRow[] = [];
      for (const file of cfg.files) {
        if (file.workspaceId !== entry.workspaceId) continue;
        const direction = directionOf(file);
        if (direction === null) continue;
        rows.push({
          root,
          workspaceId: entry.workspaceId,
          posixRel: file.localPath,
          direction,
          reason: reasonOf(direction, file),
          ...(file.editingByName === undefined ? {} : { editingByName: file.editingByName }),
        });
      }
      if (rows.length === 0) continue;
      rows.sort((a, b) => a.posixRel.localeCompare(b.posixRel, undefined, { sensitivity: "base" }));
      groups.push({
        root,
        workspaceId: entry.workspaceId,
        workspaceNote: noteFor(entry),
        suspended: normalizeWorkspaceSyncState(entry) !== "active",
        rows,
      });
    }
  }
  groups.sort(
    (a, b) =>
      a.workspaceNote.localeCompare(b.workspaceNote, undefined, { sensitivity: "base" }) ||
      a.root.localeCompare(b.root),
  );
  return groups;
}

/** Keep only rows matching the chip; groups left empty are dropped. */
export function filterDivergences(
  groups: readonly DivergenceGroup[],
  filter: DivergenceFilter,
): DivergenceGroup[] {
  if (filter === "all") return groups.map((g) => ({ ...g, rows: [...g.rows] }));
  return groups
    .map((g) => ({ ...g, rows: g.rows.filter((r) => r.direction === filter) }))
    .filter((g) => g.rows.length > 0);
}

export function summariseDivergences(groups: readonly DivergenceGroup[]): DivergenceCounts {
  const counts: DivergenceCounts = { push: 0, pull: 0, conflict: 0, total: 0 };
  for (const g of groups) {
    for (const r of g.rows) {
      counts[r.direction] += 1;
      counts.total += 1;
    }
  }
  return counts;
}

/** `↑3 ↓5 ⚠1` — status bar tooltip and the notification headline. */
export function describeDivergenceCounts(counts: DivergenceCounts): string {
  if (counts.total === 0) return "расхождений нет";
  const parts: string[] = [];
  if (counts.push > 0) parts.push(`↑${String(counts.push)}`);
  if (counts.pull > 0) parts.push(`↓${String(counts.pull)}`);
  if (counts.conflict > 0) parts.push(`⚠${String(counts.conflict)}`);
  return parts.join(" ");
}

/**
 * Rows a bulk action may actually run on.
 *
 * Conflicts are excluded from both bulk buttons on purpose: "send selected"
 * over a conflicting file means picking a side, and that choice belongs to the
 * conflict resolution flow, not to a checkbox the user ticked while selecting
 * ten other files. Suspended workspaces are excluded because the engine would
 * refuse them anyway — better to grey them out than to report a failure.
 */
export function selectableForBulk(
  groups: readonly DivergenceGroup[],
  direction: Exclude<DivergenceDirection, "conflict">,
  selectedKeys: ReadonlySet<string>,
): DivergenceRow[] {
  const out: DivergenceRow[] = [];
  for (const g of groups) {
    if (g.suspended) continue;
    for (const r of g.rows) {
      if (r.direction !== direction) continue;
      if (!selectedKeys.has(divergenceRowKey(r))) continue;
      out.push(r);
    }
  }
  return out;
}

/**
 * Separator for {@link divergenceRowKey}. NUL cannot occur in a path on any
 * platform, so no root, workspace id or relative path can forge a collision.
 *
 * Written as an escape on purpose: a raw NUL byte in a source file is what made
 * git treat `syncEngine.ts` as binary and hid it from `grep` (stage 0), and
 * `scripts/check-source-hygiene.mjs` fails the build on the raw form.
 */
export const DIVERGENCE_KEY_SEP = "\u0000";

/**
 * Stable identity of a row across refreshes — the checkbox key.
 *
 * The webview recomputes the same key in its own script, so the separator is
 * injected into the page from this constant rather than typed a second time.
 */
export function divergenceRowKey(row: {
  root: string;
  workspaceId: string;
  posixRel: string;
}): string {
  return [row.root, row.workspaceId, row.posixRel].join(DIVERGENCE_KEY_SEP);
}

/**
 * What the «Расхождения» webview is allowed to ask for.
 *
 * The protocol and its validator live in the pure layer for two reasons:
 * they are testable without a `vscode` stub, and treating webview input as
 * untrusted data is a correctness rule, not a UI detail. `commandCenter.ts`
 * and `settingsPanel.ts` take `executeCommand(msg.command, ...msg.args)`
 * straight from the page — this protocol cannot express that.
 */
export type DivergencePanelRequest =
  | { kind: "refresh" }
  | { kind: "bulk"; direction: "push" | "pull"; keys: string[] }
  | { kind: "compare"; key: string }
  | { kind: "resolve"; key: string };

/**
 * Validate an incoming webview message into a typed request.
 *
 * Returns `null` for anything unrecognised, including a well-formed message
 * carrying an unexpected value. The panel never acts on something it did not
 * define itself.
 */
export function parseDivergenceRequest(raw: unknown): DivergencePanelRequest | null {
  if (raw === null || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.kind === "refresh") return { kind: "refresh" };
  if (m.kind === "bulk") {
    if (m.direction !== "push" && m.direction !== "pull") return null;
    if (!Array.isArray(m.keys)) return null;
    const keys = m.keys.filter((k): k is string => typeof k === "string");
    if (keys.length !== m.keys.length) return null;
    return { kind: "bulk", direction: m.direction, keys };
  }
  if (m.kind === "compare" || m.kind === "resolve") {
    if (typeof m.key !== "string" || m.key.length === 0) return null;
    return { kind: m.kind, key: m.key };
  }
  return null;
}
