import type { SyncEngine } from "../core/syncEngine.js";
import type { WorkspaceSyncState } from "../core/types.js";

function tagsWithoutArchived(tags: string[]): string[] {
  return tags.filter((t) => t.trim().toLowerCase() !== "archived");
}

/** Cloud tag `archived` + локальный Suspend (roadmap 6.3). */
export async function applyArchivedTagAndSuspend(engine: SyncEngine, workspaceId: string): Promise<void> {
  const fields = await engine.getWorkspaceManifestFields(workspaceId);
  const merged = [...new Set([...(fields?.tags ?? []), "archived"])];
  await engine.setWorkspaceTags(workspaceId, merged);
  await engine.setWorkspaceSyncState(workspaceId, "suspended");
}

/**
 * Снять тег `archived`, перевести workspace в active (если был Freeze — через Suspend для PUT манифеста).
 * Вызывающий затем выполняет pull при необходимости (после preview-подтверждения).
 */
export async function stripArchivedTagAndActivate(
  engine: SyncEngine,
  workspaceId: string,
  priorSyncState: WorkspaceSyncState,
): Promise<void> {
  const fields = await engine.getWorkspaceManifestFields(workspaceId);
  if (!fields) {
    throw new Error("манифест недоступен");
  }
  const nextTags = tagsWithoutArchived(fields.tags);
  if (priorSyncState === "frozen") {
    await engine.setWorkspaceSyncState(workspaceId, "suspended");
  }
  await engine.setWorkspaceTags(workspaceId, nextTags);
  await engine.setWorkspaceSyncState(workspaceId, "active");
}
