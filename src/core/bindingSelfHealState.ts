/**
 * Session-scoped rate limit for the binding self-heal (docs/v2/linkBindings.md,
 * stage 3): at most one healing manifest PUT per workspace per session —
 * two machines with divergent local state must not ping-pong healing writes.
 * Module-level on purpose: engines are constructed per operation, so instance
 * state cannot carry the "already healed" fact across passes.
 */
import type { CloudManifest } from "./cloudLayout.js";
import { planBindingSelfHeal } from "./plan/planBindingSelfHeal.js";
import type { TrackedFile } from "./types.js";
import { warnLog } from "../utils/log.js";

const healedThisSession = new Set<string>();

export function shouldAttemptBindingSelfHeal(workspaceRoot: string, workspaceId: string): boolean {
  const key = `${workspaceRoot}\u0000${workspaceId}`;
  if (healedThisSession.has(key)) {
    return false;
  }
  healedThisSession.add(key);
  return true;
}

/**
 * I/O shell of the self-heal (kept out of `syncEngine.ts` for its size gate):
 * plan the re-assertions, write them through the caller's manifest PUT.
 * Never fatal — a failed heal only means the cloud copy stays behind for one
 * more pass.
 */
export async function runBindingSelfHeal(deps: {
  workspaceRoot: string;
  workspaceId: string;
  machineId: string;
  manifest: CloudManifest;
  trackedFiles: readonly TrackedFile[];
  nextVersion: number;
  nowIso: string;
  putManifest: (manifest: CloudManifest) => Promise<unknown>;
}): Promise<void> {
  if (!shouldAttemptBindingSelfHeal(deps.workspaceRoot, deps.workspaceId)) {
    return;
  }
  const { healedRows } = planBindingSelfHeal({
    machineId: deps.machineId,
    trackedFiles: deps.trackedFiles,
    manifestFiles: deps.manifest.files,
    folderRules: deps.manifest.folderBindings?.[deps.machineId],
    nextVersion: deps.nextVersion,
    nowIso: deps.nowIso,
  });
  if (healedRows.size === 0) {
    return;
  }
  try {
    await deps.putManifest({
      ...deps.manifest,
      files: deps.manifest.files.map((m) => healedRows.get(m.path) ?? m),
    });
  } catch (e) {
    warnLog("bindingSelfHeal", `non-fatal: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Test seam. */
export function resetBindingSelfHealState(): void {
  healedThisSession.clear();
}
