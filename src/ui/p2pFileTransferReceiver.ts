/**
 * v2.12.4 — P2P file-transfer receiver (mirror counterpart).
 *
 * Subscribes to authenticated frames on a session channel:
 *   - "manifest" → decode + create assembler keyed by transferId
 *   - "file_chunk" → route to the active assembler; finalize when complete
 *
 * On finalize:
 *   - hash check (manifest.hash vs recomputed sha256 over assembled bytes).
 *   - resolve workspace root + relPath (`planP2PStaging`) → write the bytes
 *     atomically into the **staging** folder and hand the delivery to the host.
 *
 * A peer never writes into the working tree (B15): the delivery waits in
 * staging until the user applies it. The cloud manifest stays authoritative —
 * once applied, the next cloud sync validates / reconciles / marks conflict
 * through the regular pipeline.
 *
 * Errors are logged via `warnLog` and never bubble to the caller — the
 * session must stay alive even when individual transfers fail.
 */
import {
  createChunkAssembler,
  decodeFileChunkPayload,
  decodeManifestPayload,
  type ChunkAssembler,
  type P2PFileManifest,
} from "../core/p2pFileTransfer.js";
import type { AuthenticatedP2PChannel } from "../core/p2pDataChannel.js";
import { planP2PStaging } from "../core/p2pStagingPlan.js";
import { writeFileAtomic } from "../core/writeTextFileAtomic.js";
import { warnLog, verboseLog } from "../utils/log.js";

export interface FileReceiverDeps {
  /** Resolves the workspace folder absolute path on disk for a given
   * `workspaceId`. When the receiver doesn't recognise the workspace,
   * the file is dropped — caller may also choose to mirror to a staging
   * directory. Returning `null` skips the write. */
  resolveWorkspaceRoot: (workspaceId: string | null) => string | null;
  /**
   * Called once a delivery is on disk **in staging**. The host decides what to
   * offer the user (apply / compare / reject) — the receiver never touches the
   * working tree itself.
   */
  onFileStaged: (info: {
    relPath: string;
    workspaceId: string | null;
    workspaceRoot: string;
    stagingAbs: string;
    targetAbs: string;
    bytes: number;
  }) => void;
}

export interface FileReceiverHandle {
  /** Tears down the inbound subscription. Active assemblers are dropped. */
  dispose(): void;
}

interface ActiveTransfer {
  manifest: P2PFileManifest;
  assembler: ChunkAssembler;
  /** ms timestamp the manifest landed; used for stale-cleanup heuristics. */
  startedAtMs: number;
}

const STALE_TRANSFER_TTL_MS = 5 * 60 * 1000;

export function attachFileReceiver(
  channel: AuthenticatedP2PChannel,
  deps: FileReceiverDeps,
): FileReceiverHandle {
  const transfers = new Map<string, ActiveTransfer>();

  const evictStale = (now: number): void => {
    for (const [id, t] of transfers) {
      if (now - t.startedAtMs > STALE_TRANSFER_TTL_MS) transfers.delete(id);
    }
  };

  const stageFile = async (
    workspaceId: string | null,
    manifest: P2PFileManifest,
    content: Uint8Array,
  ): Promise<void> => {
    const root = deps.resolveWorkspaceRoot(workspaceId);
    if (root === null) {
      verboseLog("p2p-receive", `dropped ${manifest.relPath} — workspace not resolved`);
      return;
    }
    const plan = planP2PStaging(root, manifest.relPath, manifest.transferId);
    if (!plan.ok) {
      warnLog("p2p-receive", `dropped ${manifest.relPath} — ${plan.reason}`);
      return;
    }
    try {
      await writeFileAtomic(plan.stagingAbs, Buffer.from(content));
      deps.onFileStaged({
        relPath: plan.relPath,
        workspaceId,
        workspaceRoot: root,
        stagingAbs: plan.stagingAbs,
        targetAbs: plan.targetAbs,
        bytes: content.byteLength,
      });
    } catch (e) {
      warnLog("p2p-receive", `stage ${manifest.relPath} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const unsubscribe = channel.onFrame(
    (type, _seq, payload) => {
      const now = Date.now();
      evictStale(now);
      if (type === "manifest") {
        const decoded = decodeManifestPayload(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
        if (!decoded.ok) {
          warnLog("p2p-receive", `manifest decode failed: ${decoded.reason}`);
          return;
        }
        transfers.set(decoded.manifest.transferId, {
          manifest: decoded.manifest,
          assembler: createChunkAssembler(decoded.manifest),
          startedAtMs: now,
        });
        return;
      }
      if (type === "file_chunk") {
        const r = decodeFileChunkPayload(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
        if (!r.ok) {
          warnLog("p2p-receive", `chunk decode failed: ${r.reason}`);
          return;
        }
        // Find the matching transfer — chunks don't carry transferId, so we
        // route to whichever assembler hasn't completed (the sender pipeline
        // serialises one transfer at a time). When multiple are in flight,
        // a chunk that doesn't fit one is offered to the next.
        for (const t of transfers.values()) {
          if (t.assembler.isComplete()) continue;
          const applied = t.assembler.applyChunk(r.chunkIndex, r.chunk);
          if (!applied.ok) continue;
          if (t.assembler.isComplete()) {
            const final = t.assembler.finalize();
            transfers.delete(t.manifest.transferId);
            if (!final.ok) {
              warnLog("p2p-receive", `finalize failed for ${t.manifest.relPath}: ${final.reason}`);
              return;
            }
            if (!final.hashOk) {
              warnLog("p2p-receive", `hash mismatch for ${t.manifest.relPath} — drop`);
              return;
            }
            // workspaceId is not on the manifest (sender doesn't include it
            // currently); rely on a single-workspace receiver heuristic — the
            // resolveWorkspaceRoot dep is called with `null` and the dep
            // chooses (e.g. first active workspace).
            void stageFile(null, t.manifest, final.content);
            return;
          }
          return;
        }
        // No matching transfer — drop the orphan chunk silently.
      }
    },
    (reason) => {
      warnLog("p2p-receive", `frame rejected: ${reason}`);
    },
  );

  return {
    dispose(): void {
      unsubscribe();
      transfers.clear();
    },
  };
}
