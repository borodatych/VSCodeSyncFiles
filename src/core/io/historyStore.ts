/**
 * `.history/` — the previous cloud version of a file, kept before it is
 * overwritten.
 *
 * Extracted from `SyncEngine` (этап 5.2). Three concerns lived tangled in the
 * engine: whether to snapshot at all (`historyMode`), the deferred queue for
 * `lazy`, and the retention prune. They are one subject and now live together.
 */
import type { ICloudProvider } from "../../providers/cloudProviderTypes.js";
import { ProviderError } from "../../providers/cloudProviderTypes.js";
import { historyDirForFile } from "../cloudLayout.js";

export type HistoryMode = "inline" | "lazy" | "off";

/** A snapshot postponed by `historyMode: "lazy"`, drained by the host later. */
export interface LazyHistoryEntry {
  workspaceId: string;
  posixRel: string;
  oldCloudPath: string;
  queuedAtMs: number;
}

export interface HistoryStoreDeps {
  provider: ICloudProvider;
  machineName: string;
  mode: () => HistoryMode;
  /** How many versions to keep per file. */
  versions: () => number;
  /** Notified when an entry lands in the deferred queue. */
  onQueued?: (entry: LazyHistoryEntry) => void;
}

export interface HistoryStore {
  /** Snapshot per the current mode: now, deferred, or not at all. */
  snapshot(workspaceId: string, posixRel: string, cloudPath: string): Promise<void>;
  /** Snapshot regardless of mode — used when draining the deferred queue. */
  snapshotNow(workspaceId: string, posixRel: string, cloudPath: string): Promise<void>;
  /** Hand over everything queued so far; the queue is left empty. */
  drain(): LazyHistoryEntry[];
  /** Number of entries waiting, without draining. */
  pending(): number;
}

export function createHistoryStore(deps: HistoryStoreDeps): HistoryStore {
  const queue: LazyHistoryEntry[] = [];

  const prune = async (workspaceId: string, posixRel: string): Promise<void> => {
    const dir = historyDirForFile(workspaceId, posixRel);
    const items = await deps.provider.listFolder(dir);
    const keep = deps.versions();
    if (items.length <= keep) {
      return;
    }
    // Names start with an ISO timestamp, so lexicographic order is chronological.
    const sorted = [...items].sort((a, b) => a.cloudPath.localeCompare(b.cloudPath));
    for (const d of sorted.slice(0, Math.max(0, sorted.length - keep))) {
      await deps.provider.deleteFile(d.cloudPath);
    }
  };

  const snapshotNow = async (
    workspaceId: string,
    posixRel: string,
    cloudPath: string,
  ): Promise<void> => {
    try {
      const cur = await deps.provider.downloadFile(cloudPath);
      if (cur.notModified || cur.body.length === 0) {
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const ext = posixRel.includes(".") ? posixRel.slice(posixRel.lastIndexOf(".")) : "";
      const safeMachine = deps.machineName.replace(/[/\\:*?"<>|]/g, "_");
      const histPath = `${historyDirForFile(workspaceId, posixRel)}/${stamp}_${safeMachine}${ext}`;
      // The bytes are copied verbatim, so an encrypted blob stays encrypted.
      await deps.provider.uploadFile(histPath, cur.body);
      await prune(workspaceId, posixRel);
    } catch (e) {
      if (e instanceof ProviderError && e.code === "NOT_FOUND") {
        return;
      }
      throw e;
    }
  };

  return {
    async snapshot(workspaceId, posixRel, cloudPath): Promise<void> {
      const mode = deps.mode();
      if (mode === "off") return;
      if (mode === "lazy") {
        const entry: LazyHistoryEntry = {
          workspaceId,
          posixRel,
          oldCloudPath: cloudPath,
          queuedAtMs: Date.now(),
        };
        queue.push(entry);
        deps.onQueued?.(entry);
        return;
      }
      await snapshotNow(workspaceId, posixRel, cloudPath);
    },
    snapshotNow,
    drain(): LazyHistoryEntry[] {
      return queue.splice(0, queue.length);
    },
    pending(): number {
      return queue.length;
    },
  };
}
