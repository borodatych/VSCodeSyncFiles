/**
 * v0.16 N15 — pure definitions for VS Code Tasks integration.
 *
 * The existing `vscodeSyncTaskProvider` registers a couple of stock
 * tasks. This module declares additional task types (push, pull,
 * snapshot, prune-history, repair-manifest, support-bundle) as
 * structured definitions so they can be invoked from `tasks.json`.
 *
 * Caller (the taskProvider) maps these to the right command id.
 */

export type VscodeSyncTaskKind =
  | "push"
  | "pull"
  | "snapshot"
  | "prune-history"
  | "repair-manifest"
  | "support-bundle";

export interface VscodeSyncTaskDef {
  type: "vscodesync";
  kind: VscodeSyncTaskKind;
  /** Optional workspaceId to target; absent = all workspaces. */
  workspaceId?: string;
}

export interface VscodeSyncTaskMetadata {
  kind: VscodeSyncTaskKind;
  label: string;
  description: string;
  commandId: string;
  /** Args picker shape — UI prompts the user when the task fires without them. */
  args?: { name: string; kind: "workspaceId" | "string"; required: boolean }[];
}

export const TASK_REGISTRY: readonly VscodeSyncTaskMetadata[] = [
  {
    kind: "push",
    label: "VSCodeSync: Push",
    description: "Push tracked changes to the active provider.",
    commandId: "vscodesync.pushAll",
    args: [{ name: "workspaceId", kind: "workspaceId", required: false }],
  },
  {
    kind: "pull",
    label: "VSCodeSync: Pull",
    description: "Pull newest cloud version into the local workspace.",
    commandId: "vscodesync.pullAll",
    args: [{ name: "workspaceId", kind: "workspaceId", required: false }],
  },
  {
    kind: "snapshot",
    label: "VSCodeSync: Snapshot",
    description: "Create a named snapshot of the current workspace state.",
    commandId: "vscodesync.createSnapshot",
    args: [{ name: "name", kind: "string", required: false }],
  },
  {
    kind: "prune-history",
    label: "VSCodeSync: Prune History",
    description: "Drop oldest entries from `.history/` per `historyVersions`.",
    commandId: "vscodesync.pruneCloudHistory",
  },
  {
    kind: "repair-manifest",
    label: "VSCodeSync: Repair Manifest",
    description: "Rebuild a corrupted cloud manifest from blob scan.",
    commandId: "vscodesync.repairCloudManifest",
  },
  {
    kind: "support-bundle",
    label: "VSCodeSync: Support Bundle",
    description: "Export a diagnostics zip (redacted) for bug reports.",
    commandId: "vscodesync.exportSupportBundle",
  },
];

/** Look up metadata by task kind. */
export function lookupTaskMetadata(kind: string): VscodeSyncTaskMetadata | null {
  return TASK_REGISTRY.find((t) => t.kind === kind) ?? null;
}
