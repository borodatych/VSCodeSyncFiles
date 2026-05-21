/**
 * v0.8 F-003 — pure planner for `vscodesync.repairCloudManifest`.
 *
 * Caller fetches:
 *   - `meta.json` entries (or empty record)
 *   - listing of `.snapshots/` (snapshot names known on cloud)
 *   - listing of file blobs under the workspace root
 *   - machine list (from `_machines.json`)
 *
 * This planner produces the minimal CloudManifest shape that would survive
 * `validateManifestShape`. Caller writes it back with a fresh ETag.
 *
 * No `vscode` import. Caller composes the full I/O.
 */

import type { CloudManifest, ManifestFile, MachineEntry } from "./cloudLayout.js";
import { SUPPORTED_MANIFEST_SCHEMA } from "./cloudLayout.js";

export interface RepairManifestInput {
  workspaceId: string;
  /** Workspace label preserved when readable; falls back to id. */
  workspaceNoteHint?: string;
  /** ProviderType to encode in the rebuilt manifest. */
  providerType: CloudManifest["providerType"];
  /** Tracked file paths discovered by scanning the cloud folder. */
  cloudFilePaths: readonly string[];
  /** Machines from `_machines.json` (best-effort). */
  machines: readonly MachineEntry[];
  /** ISO timestamp for `createdAt` / `updatedAt`. */
  nowIso?: string;
  /** Optional tags inherited from a partial parse of the broken manifest. */
  tagsHint?: readonly string[];
  /** Optional gitBranch hint. */
  gitBranchHint?: string;
}

export interface RepairManifestPlan {
  manifest: CloudManifest;
  /** Files that would be (re)included. */
  rebuiltFileCount: number;
  /** Machines preserved. */
  machineCount: number;
  /** Whether the plan should ask for confirmation (>0 files). */
  needsConfirmation: boolean;
}

export function planRepairManifest(input: RepairManifestInput): RepairManifestPlan {
  const now = input.nowIso ?? new Date().toISOString();
  const files: ManifestFile[] = input.cloudFilePaths
    .filter((p) => p.length > 0)
    .map((path) => ({
      path,
      addedAt: now,
      version: 1,
      hasSyncignoreMarkers: false,
    }));
  const machines: MachineEntry[] = input.machines.map((m) => ({ ...m }));
  const note = (input.workspaceNoteHint ?? "").trim() || input.workspaceId;
  const tags = (input.tagsHint ?? [])
    .filter((t) => t.trim().length > 0)
    .map((t) => t.trim());

  const manifest: CloudManifest = {
    schemaVersion: SUPPORTED_MANIFEST_SCHEMA,
    workspaceId: input.workspaceId,
    workspaceNote: note,
    tags,
    sharedIgnorePatterns: [],
    providerType: input.providerType,
    createdAt: now,
    updatedAt: now,
    machines,
    files,
  };
  if (input.gitBranchHint && input.gitBranchHint.trim().length > 0) {
    manifest.gitBranch = input.gitBranchHint.trim();
  }
  return {
    manifest,
    rebuiltFileCount: files.length,
    machineCount: machines.length,
    needsConfirmation: files.length > 0,
  };
}

/** Human-readable summary line for the confirmation modal. */
export function describeRepairPlan(plan: RepairManifestPlan, workspaceId: string): string {
  return `Workspace ${workspaceId}: будет восстановлено ${String(plan.rebuiltFileCount)} файлов, ${String(plan.machineCount)} машин(а/ы) в реестре.`;
}
