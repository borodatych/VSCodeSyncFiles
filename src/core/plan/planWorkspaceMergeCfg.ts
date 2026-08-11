/**
 * Local-config half of a workspace merge (extracted verbatim from
 * `syncEngine.mergeLocalTrackedAfterWorkspaceMerge` — engine line-ceiling
 * offset for Link Bindings): re-point the source workspace's tracked rows at
 * the target (canonical keys drive the blob paths), union the tag caches and
 * drop the source entry. Pure: cfg in, cfg out; throws when the merge target
 * is missing.
 */
import { trackedFileCloudPath } from "../cloudLayout.js";
import { manifestKeyOf } from "../trackedPathResolver.js";
import type { WorkspaceConfig } from "../types.js";

export function applyWorkspaceMergeToCfg(
  cfg: WorkspaceConfig,
  sourceId: string,
  targetId: string,
): WorkspaceConfig {
  const srcEnt = cfg.activeWorkspaces.find((w) => w.workspaceId === sourceId);
  const tgtEnt = cfg.activeWorkspaces.find((w) => w.workspaceId === targetId);
  if (!tgtEnt) {
    throw new Error("цель merge не найдена в активных workspace после облака");
  }
  const tagUnion = [...new Set([...(tgtEnt.tags ?? []), ...(srcEnt?.tags ?? [])])];

  const files = cfg.files.map((f) => {
    if (f.workspaceId !== sourceId) {
      return f;
    }
    return {
      ...f,
      workspaceId: targetId,
      cloudPath: trackedFileCloudPath(targetId, manifestKeyOf(f)),
    };
  });
  const activeWorkspaces = cfg.activeWorkspaces
    .filter((w) => w.workspaceId !== sourceId)
    .map((w) => (w.workspaceId === targetId && tagUnion.length > 0 ? { ...w, tags: tagUnion } : w));
  return { ...cfg, files, activeWorkspaces };
}
