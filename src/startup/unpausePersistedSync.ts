/**
 * v2.6.7 — clears the persisted `syncPaused` flag on activate.
 *
 * `globalConfig.syncPaused` survives extension restarts so a manually-paused
 * window stays paused after a reload. On every activate we transfer that
 * persisted flag into the runtime `syncSessionPause` controller and clear
 * the disk copy — the next pause must come from the user explicitly.
 *
 * Fire-and-forget; failures don't block activate.
 */
import type { GlobalConfigManager } from "../core/globalConfigManager.js";

export interface SyncSessionPauseLike {
  setPaused: (paused: boolean) => void;
}

export function unpausePersistedSync(
  globalConfig: GlobalConfigManager,
  syncSessionPause: SyncSessionPauseLike,
): void {
  void (async (): Promise<void> => {
    const g = await globalConfig.load();
    if (!g.syncPaused) return;
    syncSessionPause.setPaused(true);
    await globalConfig.set("syncPaused", false);
    await globalConfig.save();
  })();
}
