/**
 * @experimental v2.1 WebRTC P2P. Wired in v2.x — keep until UI commands
 * call `openP2PChannel`. Do NOT delete as "dead code".
 *
 * P2P data-channel facade — wraps `@roamhq/wrtc` (desktop) and the browser
 * WebRTC API (web) behind one tiny interface. The signaling envelope sits in
 * `p2pSignaling.ts`; this module owns the actual connection lifecycle.
 *
 * Loaded lazily so installs without `@roamhq/wrtc` boot cleanly. Callers
 * should branch on `isP2PAvailable()` before opening a channel.
 *
 * For authenticated frame exchange use `wrapAuthenticated()` to layer the
 * `p2pCryptoEnvelope` on top of an existing `P2PChannel` — it handles
 * monotonic seq numbers, type-tagged dispatch, and authTag verification.
 */
import {
  decodeP2PFrame,
  encodeP2PFrame,
  type P2PFrameTypeName,
} from "./p2pCryptoEnvelope.js";

export interface P2PChannelOptions {
  /** Standard ICE servers; defaults to a single Google STUN. */
  iceServers?: { urls: string }[];
  /** Local label for the data channel (peers must agree on it). */
  channelLabel?: string;
}

export interface P2PChannel {
  /** Send a binary frame over the data channel. Throws when channel closed. */
  send(data: Uint8Array): void;
  /** Subscribe to inbound frames; returns disposer. */
  onMessage(handler: (data: Uint8Array) => void): () => void;
  /** True when the channel is in `open` state and `send` won't throw. */
  isOpen(): boolean;
  /** Close the channel and the underlying peer connection. Idempotent. */
  close(): void;
}

export interface AuthenticatedP2PChannel {
  /** Encode + send an envelope. Increments local seq counter. */
  sendFrame(type: P2PFrameTypeName, payload: Buffer): void;
  /**
   * Subscribe to authenticated inbound frames. Frames that fail decode
   * (authTag mismatch, bad version, replay) go to `onReject` so the caller
   * can log / disconnect; valid frames go to `onFrame`.
   */
  onFrame(
    onFrame: (type: P2PFrameTypeName, seq: number, payload: Buffer) => void,
    onReject?: (reason: string) => void,
  ): () => void;
  /** True when the underlying channel is open. */
  isOpen(): boolean;
  /** Close the underlying channel + clear seq counters. */
  close(): void;
}

interface DataChannelLike {
  readyState: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}

interface PeerConnectionLike {
  createDataChannel(label: string): DataChannelLike;
  close(): void;
}

interface WrtcModule {
  RTCPeerConnection: new (cfg: { iceServers: { urls: string }[] }) => PeerConnectionLike;
}

let cachedModule: WrtcModule | null | undefined;

async function loadWrtc(): Promise<WrtcModule | null> {
  if (cachedModule !== undefined) return cachedModule;
  try {
    cachedModule = await import("@roamhq/wrtc");
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

export async function isP2PAvailable(): Promise<boolean> {
  const m = await loadWrtc();
  return m !== null;
}

/**
 * Create a peer connection + a single data channel. The result is a thin
 * channel object only — full offer/answer handshake is the caller's job
 * (signaling envelopes live in `p2pSignaling.ts`).
 *
 * Returns `null` when the WebRTC backend is not installed in this build —
 * UI layers should fall back to cloud-only sync silently.
 */
export async function openP2PChannel(opts: P2PChannelOptions = {}): Promise<P2PChannel | null> {
  const wrtc = await loadWrtc();
  if (!wrtc) return null;
  const pc = new wrtc.RTCPeerConnection({
    iceServers: opts.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
  });
  const channel = pc.createDataChannel(opts.channelLabel ?? "vscodesync-p2p");
  return wrapChannel(channel, pc);
}

export function wrapChannel(
  channel: DataChannelLike,
  pc: PeerConnectionLike,
): P2PChannel {
  let closed = false;
  return {
    send(data: Uint8Array): void {
      if (closed) throw new Error("P2P channel closed");
      if (channel.readyState !== "open") {
        throw new Error(`P2P channel not open (state=${channel.readyState})`);
      }
      channel.send(data);
    },
    onMessage(handler): () => void {
      const listener = (ev: { data: unknown }): void => {
        if (ev.data instanceof ArrayBuffer) {
          handler(new Uint8Array(ev.data));
        } else if (ev.data instanceof Uint8Array) {
          handler(ev.data);
        } else if (ev.data && ArrayBuffer.isView(ev.data)) {
          const view = ev.data;
          handler(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        }
      };
      channel.addEventListener("message", listener);
      return () => { channel.removeEventListener("message", listener); };
    },
    isOpen(): boolean {
      return !closed && channel.readyState === "open";
    },
    close(): void {
      if (closed) return;
      closed = true;
      try { channel.close(); } catch { /* ignore */ }
      try { pc.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * Wrap a raw `P2PChannel` in the authenticated envelope from
 * `p2pCryptoEnvelope`. Outbound frames get a monotonic seq starting at 0;
 * inbound frames are validated against `expectedSeq` (also starting at 0)
 * so a replay or out-of-order delivery routes to `onReject` rather than
 * silently being delivered.
 *
 * Both sides must use this wrapper with a shared 32-byte AES key and start
 * their counters at 0.
 */
export function wrapAuthenticated(channel: P2PChannel, key: Buffer): AuthenticatedP2PChannel {
  let outSeq = 0;
  let expectedInSeq = 0;
  let unsubscribeRaw: (() => void) | null = null;
  return {
    sendFrame(type, payload): void {
      const frame = encodeP2PFrame(key, { type, seq: outSeq, payload });
      outSeq = (outSeq + 1) >>> 0; // u32 wrap-around — seq itself is checked
      channel.send(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
    },
    onFrame(onFrame, onReject): () => void {
      unsubscribeRaw?.();
      unsubscribeRaw = channel.onMessage((data) => {
        const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        const result = decodeP2PFrame(key, buf, expectedInSeq);
        if (!result.ok) {
          onReject?.(result.reason);
          return;
        }
        expectedInSeq = (expectedInSeq + 1) >>> 0;
        onFrame(result.type, result.seq, result.payload);
      });
      return () => {
        unsubscribeRaw?.();
        unsubscribeRaw = null;
      };
    },
    isOpen(): boolean {
      return channel.isOpen();
    },
    close(): void {
      unsubscribeRaw?.();
      unsubscribeRaw = null;
      outSeq = 0;
      expectedInSeq = 0;
      channel.close();
    },
  };
}
