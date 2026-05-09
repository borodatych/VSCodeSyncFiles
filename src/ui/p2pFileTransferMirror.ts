/**
 * v2.12.4 — bridge `engine.onPushFile` to live P2P sessions.
 *
 * The engine fires `onPushFile(workspaceId, posixRel, plaintext, meta)` after
 * a successful cloud upload. When at least one P2P session is active for the
 * same workspace (looked up via the registry's `peerLabel` heuristic), this
 * mirror:
 *   1. Plans the file into 16 KB chunks via `planP2PFileChunks`.
 *   2. Encodes the manifest as a `manifest` frame.
 *   3. Streams every chunk as a `file_chunk` frame.
 *
 * Both sides of the wire share the AES key bound at session open time, so
 * `wrapAuthenticated.sendFrame` does the encryption + sequence + authTag
 * plumbing for free.
 *
 * The mirror is purely best-effort: errors thrown while encoding or sending
 * are swallowed. The cloud upload has already succeeded, the manifest is
 * authoritative, and a peer that missed the live mirror falls back to the
 * regular cloud-pull path.
 */
import { randomUUID } from "node:crypto";
import {
  encodeFileChunkPayload,
  encodeManifestPayload,
  planP2PFileChunks,
} from "../core/p2pFileTransfer.js";
import type { AuthenticatedP2PChannel } from "../core/p2pDataChannel.js";
import { warnLog } from "../utils/log.js";

export interface FileMirrorTarget {
  workspaceId: string;
  channel: AuthenticatedP2PChannel;
}

export interface MirrorRegistry {
  /** All currently authenticated outbound channels. The workspace filter is
   * advisory — when the mirror has no per-workspace binding, every connected
   * peer receives the frame and the receiver decides whether the manifest's
   * relPath is interesting. */
  targetsFor(workspaceId: string): FileMirrorTarget[];
}

/**
 * Run a single mirror dispatch. Suitable for direct hookup as
 * `engine.onPushFile`.
 *
 * @param plaintext file contents AFTER canonicalisation but BEFORE encrypt
 *                  (engine passes the canonical buffer)
 */
export function mirrorPushedFile(
  registry: MirrorRegistry,
  workspaceId: string,
  posixRel: string,
  plaintext: Buffer,
): void {
  const targets = registry.targetsFor(workspaceId);
  if (targets.length === 0) return;
  let plan;
  try {
    plan = planP2PFileChunks(new Uint8Array(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength), {
      transferId: randomUUID(),
      relPath: posixRel,
    });
  } catch (e) {
    warnLog("p2p-mirror", `plan failed for ${posixRel}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const manifestFrame = Buffer.from(encodeManifestPayload(plan.manifest));
  for (const t of targets) {
    if (!t.channel.isOpen()) continue;
    try {
      t.channel.sendFrame("manifest", manifestFrame);
      for (let i = 0; i < plan.chunks.length; i++) {
        const buf = encodeFileChunkPayload(i, plan.chunks[i] ?? new Uint8Array(0));
        t.channel.sendFrame("file_chunk", Buffer.from(buf));
      }
    } catch (e) {
      warnLog("p2p-mirror", `send failed for ${posixRel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * In-memory mirror registry that lives alongside the P2P session registry.
 * Sessions register their authenticated channel + workspace binding when
 * they enter `connected` state; they unregister on `close`.
 *
 * Uses a `workspaceId → Set<channel-id>` index so the dispatcher only walks
 * the targets relevant for the file being mirrored.
 */
export interface MirrorRegistryHandle extends MirrorRegistry {
  /** Bind a session to the mirror. `workspaceId` is optional — pass null
   * when the session is workspace-agnostic and every push should fan out. */
  bind(sessionId: string, workspaceId: string | null, channel: AuthenticatedP2PChannel): void;
  unbind(sessionId: string): void;
  size(): number;
}

interface BoundEntry {
  sessionId: string;
  workspaceId: string | null;
  channel: AuthenticatedP2PChannel;
}

export function createMirrorRegistry(): MirrorRegistryHandle {
  const bySession = new Map<string, BoundEntry>();
  return {
    bind(sessionId, workspaceId, channel): void {
      bySession.set(sessionId, { sessionId, workspaceId, channel });
    },
    unbind(sessionId): void {
      bySession.delete(sessionId);
    },
    size(): number {
      return bySession.size;
    },
    targetsFor(workspaceId): FileMirrorTarget[] {
      const out: FileMirrorTarget[] = [];
      for (const e of bySession.values()) {
        if (e.workspaceId === null || e.workspaceId === workspaceId) {
          out.push({ workspaceId, channel: e.channel });
        }
      }
      return out;
    },
  };
}
