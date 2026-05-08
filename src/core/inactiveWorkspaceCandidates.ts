/**
 * Pure candidate-builder for "inactive workspace" prompts. Two UI flows
 * use the same shape (long-absence archive in `workspaceInactiveArchive.ts`
 * and early-archive suggestion in `smartWorkspaceSuggestions.ts`); both
 * inlined an identical loop.
 *
 * Caller assembles `folders[]` from `WorkspaceConfigManager.load(...)` —
 * see existing pure helpers (`hasArchivedTag`, `newestTrackedLastSyncMs`,
 * `normalizeWorkspaceSyncState`) — and supplies the snooze map from
 * `globalState`. The pure helper does the filter + threshold + sort.
 *
 * No `vscode`, no IO. Output is sorted by inactiveDays desc so the UI can
 * surface the most-stale workspace first.
 *
 * Snooze keys use NUL as the separator between folder path and workspace
 * id so collisions are impossible (NUL cannot appear in a real path).
 */

export const INACTIVE_SNOOZE_NEVER = "__never";
const INACTIVE_SNOOZE_KEY_SEPARATOR = String.fromCharCode(0);

const DAY_MS = 86_400_000;

export interface InactiveWorkspaceFolderInput {
  folderRootFsPath: string;
  workspaces: readonly InactiveWorkspaceCandidateInput[];
}

export interface InactiveWorkspaceCandidateInput {
  workspaceId: string;
  workspaceNote: string;
  /** True when the workspace already carries the `archived` tag — caller
   *  should treat such entries as already-archived and skip them. */
  archived: boolean;
  /** True when `normalizeWorkspaceSyncState(...)` returned "active". */
  active: boolean;
  /** Most-recent successful sync timestamp; `undefined` means "never". */
  lastSyncMs: number | undefined;
}

export interface InactiveCandidatesInput {
  folders: readonly InactiveWorkspaceFolderInput[];
  /** Inclusive lower bound on inactiveDays. Below this -> not a candidate. */
  minInactiveDays: number;
  /** Exclusive upper bound. `undefined` -> no upper bound. Must be greater
   *  than `minInactiveDays` when set. */
  maxInactiveDays?: number;
  /** Snooze map keyed by `inactiveSnoozeKey(folder, workspaceId)`. Values
   *  are ISO timestamps OR the `INACTIVE_SNOOZE_NEVER` sentinel. */
  snoozes?: Readonly<Record<string, string>>;
  nowMs?: number;
}

export interface InactiveWorkspaceCandidate {
  folderRootFsPath: string;
  workspaceId: string;
  workspaceNote: string;
  inactiveDays: number;
}

export function isInactiveSnoozeActive(
  value: string | undefined,
  nowMs: number,
): boolean {
  if (value === INACTIVE_SNOOZE_NEVER) return true;
  if (value === undefined || value === "") return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && nowMs < t;
}

export function inactiveSnoozeKey(
  folderRootFsPath: string,
  workspaceId: string,
): string {
  return folderRootFsPath + INACTIVE_SNOOZE_KEY_SEPARATOR + workspaceId;
}

export function findInactiveWorkspaceCandidates(
  input: InactiveCandidatesInput,
): InactiveWorkspaceCandidate[] {
  if (!Number.isFinite(input.minInactiveDays) || input.minInactiveDays < 0) {
    return [];
  }
  if (
    input.maxInactiveDays !== undefined &&
    (input.maxInactiveDays <= input.minInactiveDays || !Number.isFinite(input.maxInactiveDays))
  ) {
    return [];
  }
  const now = input.nowMs ?? Date.now();
  const snoozes = input.snoozes ?? {};
  const out: InactiveWorkspaceCandidate[] = [];
  for (const folder of input.folders) {
    for (const ws of folder.workspaces) {
      if (ws.archived) continue;
      if (!ws.active) continue;
      if (ws.lastSyncMs === undefined) continue;
      const inactiveDays = (now - ws.lastSyncMs) / DAY_MS;
      if (inactiveDays < input.minInactiveDays) continue;
      if (input.maxInactiveDays !== undefined && inactiveDays >= input.maxInactiveDays) continue;
      const key = inactiveSnoozeKey(folder.folderRootFsPath, ws.workspaceId);
      if (isInactiveSnoozeActive(snoozes[key], now)) continue;
      out.push({
        folderRootFsPath: folder.folderRootFsPath,
        workspaceId: ws.workspaceId,
        workspaceNote: ws.workspaceNote,
        inactiveDays,
      });
    }
  }
  out.sort((a, b) => b.inactiveDays - a.inactiveDays);
  return out;
}
