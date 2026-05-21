/**
 * v0.16 N02 — pure planner for Jupyter `.ipynb` cell-level conflict
 * resolution.
 *
 * Standard 3-way text merge destroys notebook metadata (kernel name, cell
 * ids, output state, execution_count). This planner walks the JSON
 * structure and produces a cell-by-cell merge plan: for each cell, decide
 *   - keep-base: cell unchanged on both sides
 *   - keep-local: only local edited
 *   - keep-remote: only remote edited
 *   - conflict: both edited differently (user must pick)
 *   - new-local / new-remote: cell inserted on one side
 *
 * No `vscode` import. Caller wires this into the conflict resolution UI.
 */

export type NotebookCellId = string;

export interface NotebookCell {
  id?: NotebookCellId;
  /** nbformat says `code` / `markdown` / `raw`; future kinds tolerated as
   *  arbitrary strings. */
  cell_type: string;
  source: string | string[];
  /** Outputs are intentionally excluded from intent comparison. */
  outputs?: unknown[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
}

export interface NotebookDocument {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

export type CellMergeAction =
  | "keep-base"
  | "keep-local"
  | "keep-remote"
  | "conflict"
  | "new-local"
  | "new-remote";

export interface CellMergeRow {
  index: number;
  cellId: NotebookCellId | null;
  action: CellMergeAction;
  /** Brief reason for diagnostics: "source-changed-local-only", etc. */
  reason: string;
}

export interface NotebookConflictPlan {
  cells: CellMergeRow[];
  conflictCount: number;
  newOnLocal: number;
  newOnRemote: number;
  /** True when local+remote produced same effective notebook (only outputs differ). */
  effectivelySame: boolean;
}

function normaliseSource(s: string | string[] | undefined): string {
  if (s === undefined) return "";
  return Array.isArray(s) ? s.join("") : s;
}

function cellKey(cell: NotebookCell, idx: number): string {
  // For cells with an `id` (nbformat ≥ 4.5), the id is stable across local
  // and remote and survives reorders. For id-less legacy notebooks we fall
  // back to the cell's position within ITS OWN document — this is the same
  // notion of identity for all three maps (base / local / remote), so a
  // cell at index 0 in `local` aligns with index 0 in `remote`.
  return cell.id ?? `__pos_${String(idx)}`;
}

function cellSourceEquals(a: NotebookCell, b: NotebookCell): boolean {
  return (
    a.cell_type === b.cell_type &&
    normaliseSource(a.source) === normaliseSource(b.source)
  );
}

/** Parse a notebook JSON string. Returns null when shape is invalid. */
export function tryParseNotebook(raw: string): NotebookDocument | null {
  try {
    const parsed = JSON.parse(raw) as Partial<NotebookDocument>;
    if (!Array.isArray(parsed.cells)) return null;
    return parsed as NotebookDocument;
  } catch {
    return null;
  }
}

export function planNotebookConflict(
  base: NotebookDocument | null,
  local: NotebookDocument,
  remote: NotebookDocument,
): NotebookConflictPlan {
  const baseMap = new Map<string, NotebookCell>();
  base?.cells.forEach((c, i) => { baseMap.set(cellKey(c, i), c); });

  const localMap = new Map<string, NotebookCell>();
  local.cells.forEach((c, i) => { localMap.set(cellKey(c, i), c); });

  const remoteMap = new Map<string, NotebookCell>();
  remote.cells.forEach((c, i) => { remoteMap.set(cellKey(c, i), c); });

  // Union of all keys preserving local-then-remote order.
  // v0.17 A2 fix: each side's cells are keyed by their OWN-document index
  // (matching localMap / remoteMap above), not a running union counter —
  // otherwise id-less remote cells get keys remote-cell-3 instead of
  // remote-cell-1 and lookups miss.
  const seen = new Set<string>();
  const orderedKeys: string[] = [];
  for (let i = 0; i < local.cells.length; i += 1) {
    const k = cellKey(local.cells[i], i);
    if (!seen.has(k)) {
      seen.add(k);
      orderedKeys.push(k);
    }
  }
  for (let i = 0; i < remote.cells.length; i += 1) {
    const k = cellKey(remote.cells[i], i);
    if (!seen.has(k)) {
      seen.add(k);
      orderedKeys.push(k);
    }
  }

  const rows: CellMergeRow[] = [];
  let conflictCount = 0;
  let newOnLocal = 0;
  let newOnRemote = 0;
  let allSame = true;

  for (let i = 0; i < orderedKeys.length; i += 1) {
    const key = orderedKeys[i];
    const localCell = localMap.get(key);
    const remoteCell = remoteMap.get(key);
    const baseCell = baseMap.get(key);

    if (localCell && !remoteCell) {
      rows.push({ index: i, cellId: localCell.id ?? null, action: "new-local", reason: "inserted-local" });
      newOnLocal += 1;
      allSame = false;
      continue;
    }
    if (remoteCell && !localCell) {
      rows.push({ index: i, cellId: remoteCell.id ?? null, action: "new-remote", reason: "inserted-remote" });
      newOnRemote += 1;
      allSame = false;
      continue;
    }
    if (!localCell || !remoteCell) {
      // Unreachable given the union loop, but TS narrowing aid.
      continue;
    }
    const localVsBase = baseCell ? cellSourceEquals(localCell, baseCell) : false;
    const remoteVsBase = baseCell ? cellSourceEquals(remoteCell, baseCell) : false;
    if (cellSourceEquals(localCell, remoteCell)) {
      rows.push({ index: i, cellId: localCell.id ?? null, action: "keep-base", reason: "both-equal" });
      continue;
    }
    if (localVsBase && !remoteVsBase) {
      rows.push({ index: i, cellId: localCell.id ?? null, action: "keep-remote", reason: "only-remote-edited" });
      allSame = false;
      continue;
    }
    if (remoteVsBase && !localVsBase) {
      rows.push({ index: i, cellId: localCell.id ?? null, action: "keep-local", reason: "only-local-edited" });
      allSame = false;
      continue;
    }
    rows.push({ index: i, cellId: localCell.id ?? null, action: "conflict", reason: "both-edited" });
    conflictCount += 1;
    allSame = false;
  }

  return {
    cells: rows,
    conflictCount,
    newOnLocal,
    newOnRemote,
    effectivelySame: allSame,
  };
}
