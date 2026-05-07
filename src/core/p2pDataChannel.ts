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
 */

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
