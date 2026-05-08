/**
 * v2.1.1 — signaling transport over `ICloudProvider`. Pure logic on top of the
 * provider primitives (`uploadFile` / `downloadFile` / `listFolder` /
 * `deleteFile`). No `vscode` import here so it stays unit-testable with a fake
 * provider.
 *
 * Responsibilities:
 *   - Write offer / answer / bye / ICE blobs to the cloud paths defined by
 *     `p2pSignalingChannel.ts`.
 *   - Poll for the peer's offer / answer with retry + freshness validation.
 *   - List + read all ICE candidates from the peer's folder.
 *   - Cleanup `_p2p/{sessionId}/` after `SIGNALING_CHANNEL_CLEANUP_AFTER_IDLE_MS`.
 */
import {
  buildIceCandidateEnvelope,
  buildSignalingEnvelope,
  cloudPathForIceCandidate,
  cloudPathForSessionFolder,
  cloudPathForSignaling,
  decodeSignalingEnvelope,
  type SignalingChannelEnvelope,
  type SignalingKind,
  SIGNALING_CHANNEL_CLEANUP_AFTER_IDLE_MS,
} from "../core/p2pSignalingChannel.js";
import type { P2PAnswer, P2PBye, P2PIce, P2POffer } from "../core/p2pSignaling.js";
import type {
  ICloudProvider,
  FileMetadata,
} from "../providers/cloudProviderTypes.js";

export interface PollOptions {
  /** Initial delay before the first poll. Default 0 ms. */
  initialDelayMs?: number;
  /** Max wall-clock time to wait. Default 60 s. */
  timeoutMs?: number;
  /** Backoff factor: each next delay = previous × factor. Default 1.5. */
  factor?: number;
  /** Cap on individual delays. Default 5 s. */
  maxDelayMs?: number;
  /** Provided sleep so tests can advance fake timers deterministically. */
  sleep?: (ms: number) => Promise<void>;
  /** AbortSignal — caller can cancel a long-running poll. */
  signal?: AbortSignal;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === "object" && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
  });

export interface SignalingTransport {
  writeOffer(sessionId: string, signal: P2POffer): Promise<void>;
  writeAnswer(sessionId: string, signal: P2PAnswer): Promise<void>;
  writeBye(sessionId: string, signal: P2PBye): Promise<void>;
  writeIceCandidate(sessionId: string, candidateId: string, signal: P2PIce): Promise<void>;
  pollForOffer(sessionId: string, options?: PollOptions): Promise<P2POffer | null>;
  pollForAnswer(sessionId: string, options?: PollOptions): Promise<P2PAnswer | null>;
  listIceFromPeer(sessionId: string): Promise<P2PIce[]>;
  cleanupSession(sessionId: string, idleSinceMs: number, now?: number): Promise<boolean>;
}

export interface CreateTransportOptions {
  provider: ICloudProvider;
  /** Workspace-write permission probe. If `false`, every write throws. */
  workspaceWritable: boolean;
  /** Override `now()` for tests (e.g. fake clock). */
  now?: () => number;
}

export class SignalingNotWritableError extends Error {
  constructor() {
    super("Signaling transport: workspace is not writable");
    this.name = "SignalingNotWritableError";
  }
}

/** Build a transport bound to the given provider. */
export function createSignalingTransport(options: CreateTransportOptions): SignalingTransport {
  const { provider, workspaceWritable } = options;
  const now = options.now ?? ((): number => Date.now());

  function assertWritable(): void {
    if (!workspaceWritable) throw new SignalingNotWritableError();
  }

  async function writeKind(
    sessionId: string,
    kind: "offer" | "answer" | "bye",
    signal: P2POffer | P2PAnswer | P2PBye,
  ): Promise<void> {
    assertWritable();
    const env = buildSignalingEnvelope(sessionId, kind, signal, now());
    const buf = Buffer.from(JSON.stringify(env), "utf8");
    await provider.uploadFile(cloudPathForSignaling(sessionId, kind), buf);
  }

  async function readKind(
    sessionId: string,
    kind: SignalingKind,
  ): Promise<SignalingChannelEnvelope | null> {
    try {
      const res = await provider.downloadFile(cloudPathForSignaling(sessionId, kind as "offer" | "answer" | "bye"));
      const decoded = decodeSignalingEnvelope(res.body, {
        expectedSessionId: sessionId,
        expectedKind: kind,
        now: now(),
      });
      return decoded.ok ? decoded.envelope : null;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "NOT_FOUND") return null;
      throw err;
    }
  }

  return {
    async writeOffer(sessionId, signal): Promise<void> {
      await writeKind(sessionId, "offer", signal);
    },
    async writeAnswer(sessionId, signal): Promise<void> {
      await writeKind(sessionId, "answer", signal);
    },
    async writeBye(sessionId, signal): Promise<void> {
      await writeKind(sessionId, "bye", signal);
    },
    async writeIceCandidate(sessionId, candidateId, signal): Promise<void> {
      assertWritable();
      const env = buildIceCandidateEnvelope(sessionId, candidateId, signal, now());
      const buf = Buffer.from(JSON.stringify(env), "utf8");
      await provider.uploadFile(cloudPathForIceCandidate(sessionId, candidateId), buf);
    },
    async pollForOffer(sessionId, opts = {}): Promise<P2POffer | null> {
      const env = await pollKind(sessionId, "offer", opts, readKind, now);
      return env ? (env.signal as P2POffer) : null;
    },
    async pollForAnswer(sessionId, opts = {}): Promise<P2PAnswer | null> {
      const env = await pollKind(sessionId, "answer", opts, readKind, now);
      return env ? (env.signal as P2PAnswer) : null;
    },
    async listIceFromPeer(sessionId): Promise<P2PIce[]> {
      let entries: FileMetadata[];
      try {
        entries = await provider.listFolder(`${cloudPathForSessionFolder(sessionId)}/ice`);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "NOT_FOUND") return [];
        throw err;
      }
      const out: P2PIce[] = [];
      for (const e of entries) {
        if (e.size === undefined) continue;
        try {
          const res = await provider.downloadFile(e.cloudPath);
          const decoded = decodeSignalingEnvelope(res.body, {
            expectedSessionId: sessionId,
            expectedKind: "ice",
            now: now(),
          });
          if (decoded.ok && decoded.envelope.signal.kind === "ice") {
            out.push(decoded.envelope.signal);
          }
        } catch {
          // Skip individual download failures — best-effort listing.
        }
      }
      return out;
    },
    async cleanupSession(sessionId, idleSinceMs, nowMs): Promise<boolean> {
      const cur = nowMs ?? now();
      if (cur - idleSinceMs < SIGNALING_CHANNEL_CLEANUP_AFTER_IDLE_MS) return false;
      const root = cloudPathForSessionFolder(sessionId);
      let entries: FileMetadata[];
      try {
        entries = await provider.listFolder(root);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "NOT_FOUND") return true;
        throw err;
      }
      for (const e of entries) {
        try {
          await provider.deleteFile(e.cloudPath);
        } catch {
          // best-effort
        }
      }
      return true;
    },
  };
}

async function pollKind(
  sessionId: string,
  kind: SignalingKind,
  opts: PollOptions,
  reader: (sessionId: string, kind: SignalingKind) => Promise<SignalingChannelEnvelope | null>,
  now: () => number,
): Promise<SignalingChannelEnvelope | null> {
  const sleep = opts.sleep ?? defaultSleep;
  const factor = opts.factor ?? 1.5;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = now();

  if (opts.initialDelayMs !== undefined && opts.initialDelayMs > 0) {
    await sleep(opts.initialDelayMs);
  }

  let delay = 200;
  for (;;) {
    if (opts.signal?.aborted) return null;
    const env = await reader(sessionId, kind);
    if (env) return env;
    if (now() - start >= timeoutMs) return null;
    await sleep(delay);
    delay = Math.min(Math.floor(delay * factor), maxDelayMs);
  }
}
