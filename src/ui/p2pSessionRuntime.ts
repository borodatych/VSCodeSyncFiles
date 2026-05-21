/**
 * v2.12.4 — live P2P session runtime.
 *
 * Glues:
 *   - `@roamhq/wrtc` peer connection + data channel (lazy-loaded; absent
 *     binding → fail-closed with `wrtc_unavailable`),
 *   - cloud-based `SignalingTransport` (offer/answer/ICE round-trip),
 *   - `p2pSessionStateMachine` (lifecycle + heartbeat tracking),
 *   - `p2pCryptoEnvelope` via `wrapAuthenticated` (frame layer),
 *   - `p2pSessionRegistry` (so the status bar reflects live state).
 *
 * The runtime is the missing piece between the wizard and the wire — it
 * was previously gated behind `vscodesync.p2p.experimental` with a sentinel
 * "not yet implemented" message in the command. With this module the
 * experimental setting actually opens the channel.
 *
 * Flow (inviter):
 *   1. Pick session id (uuid), build new RTCPeerConnection + data channel.
 *   2. Subscribe to `pc.onicecandidate` → `signal.writeIceCandidate`.
 *   3. createOffer → setLocalDescription → `signal.writeOffer`.
 *   4. Poll for answer → setRemoteDescription.
 *   5. Drain peer's queued ICE → addIceCandidate.
 *   6. dc.onopen → wrapAuthenticated(channel, key) → register in registry.
 *
 * Invitee mirrors with create/setLocal answer + accept-offer ICE.
 */
import { wrapAuthenticated, wrapChannel, type AuthenticatedP2PChannel, type P2PChannel } from "../core/p2pDataChannel.js";
import type { SignalingTransport } from "./p2pSignalingTransport.js";
import type { P2PSessionRegistry } from "../core/p2pSessionRegistry.js";
import { createP2PSessionMachine, type P2PSessionEvent, type SessionMachineHandle } from "../core/p2pSessionStateMachine.js";
import { createP2PIdleTracker, type IdleTrackerHandle } from "../core/p2pIdleDisconnect.js";

const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const POLL_TIMEOUT_MS = 30_000;
const ICE_DRAIN_INTERVAL_MS = 1_000;
const IDLE_TICK_INTERVAL_MS = 30_000;

export type P2PRuntimeRole = "inviter" | "invitee";

export interface OpenP2PSessionOptions {
  role: P2PRuntimeRole;
  sessionId: string;
  myMachineId: string;
  peerMachineId: string;
  encryptionKey: Buffer;
  signaling: SignalingTransport;
  registry: P2PSessionRegistry;
  iceServers?: { urls: string }[];
  /** Inject `@roamhq/wrtc` for tests. Production path lazy-loads. */
  wrtcOverride?: WrtcModule | null;
  /** AbortSignal — caller cancels long polls / pending negotiation. */
  abortSignal?: AbortSignal;
  /** v2.12.5 — caller forwards every state-machine event to activity log. */
  onSessionEvent?: (event: P2PSessionEvent) => void;
}

export type OpenP2PSessionResult =
  | { ok: true; channel: AuthenticatedP2PChannel; machine: SessionMachineHandle; idle: IdleTrackerHandle; close: () => void }
  | { ok: false; reason: "wrtc_unavailable" | "signaling_failed" | "no_offer" | "no_answer" | "channel_open_timeout" | "aborted"; detail?: string };

interface RTCSessionDescriptionInitLike {
  type: "offer" | "answer";
  sdp: string;
}

interface RTCIceCandidateInitLike {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

interface PeerConnectionLive {
  createDataChannel(label: string): unknown;
  createOffer(): Promise<RTCSessionDescriptionInitLike>;
  createAnswer(): Promise<RTCSessionDescriptionInitLike>;
  setLocalDescription(desc: RTCSessionDescriptionInitLike): Promise<void>;
  setRemoteDescription(desc: RTCSessionDescriptionInitLike): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInitLike): Promise<void>;
  close(): void;
  onicecandidate: ((ev: { candidate: RTCIceCandidateInitLike | null }) => void) | null;
  ondatachannel: ((ev: { channel: unknown }) => void) | null;
}

interface WrtcModule {
  RTCPeerConnection: new (cfg: { iceServers: { urls: string }[] }) => PeerConnectionLive;
}

let cached: WrtcModule | null | undefined;
async function loadWrtc(): Promise<WrtcModule | null> {
  if (cached !== undefined) return cached;
  try {
    const dynamic = (specifier: string): Promise<unknown> => import(specifier);
    cached = await dynamic("@roamhq/wrtc") as WrtcModule;
  } catch {
    cached = null;
  }
  return cached;
}

function describeIce(c: RTCIceCandidateInitLike): { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } {
  return { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };
}

export async function openP2PSession(opts: OpenP2PSessionOptions): Promise<OpenP2PSessionResult> {
  const wrtc = opts.wrtcOverride !== undefined ? opts.wrtcOverride : await loadWrtc();
  if (!wrtc) return { ok: false, reason: "wrtc_unavailable", detail: "@roamhq/wrtc binding not loadable" };

  const pc = new wrtc.RTCPeerConnection({ iceServers: opts.iceServers ?? DEFAULT_ICE_SERVERS });
  const machine = createP2PSessionMachine();
  machine.start(Date.now());

  let dataChannelLike: unknown = null;
  // Deferred holder pattern: TS's flow analysis can't see assignments inside
  // a Promise executor, so a bare `let` typed as `... | null` is narrowed
  // to `never` after construction. Putting the resolver on an object
  // property defeats the narrowing.
  const deferred: { resolve: (value: unknown) => void } = {
    resolve: () => { /* replaced synchronously by the executor below */ },
  };
  const dataChannelPromise = new Promise<unknown>((resolve) => { deferred.resolve = resolve; });

  // Inviter creates the data channel immediately; invitee waits for ondatachannel.
  if (opts.role === "inviter") {
    dataChannelLike = pc.createDataChannel("vscodesync-p2p");
    deferred.resolve(dataChannelLike);
  } else {
    pc.ondatachannel = (ev: { channel: unknown }): void => {
      dataChannelLike = ev.channel;
      deferred.resolve(ev.channel);
    };
  }

  let iceCandidateSeq = 0;
  pc.onicecandidate = (ev): void => {
    if (!ev.candidate) return;
    const id = `${opts.sessionId}-${String(iceCandidateSeq++)}`;
    void opts.signaling.writeIceCandidate(opts.sessionId, id, {
      kind: "ice",
      ...describeIce(ev.candidate),
      fromMachineId: opts.myMachineId,
      toMachineId: opts.peerMachineId,
      sessionId: opts.sessionId,
    }).catch(() => undefined);
  };

  // Cleanup helper used by every error path below.
  let iceDrainHandle: ReturnType<typeof setInterval> | null = null;
  const cleanup = (reason: string): void => {
    if (iceDrainHandle !== null) {
      clearInterval(iceDrainHandle);
      iceDrainHandle = null;
    }
    machine.end(Date.now(), reason);
    try { pc.close(); } catch { /* ignore */ }
  };

  try {
    if (opts.role === "inviter") {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await opts.signaling.writeOffer(opts.sessionId, {
        kind: "offer",
        sdp: offer.sdp,
        fromMachineId: opts.myMachineId,
        toMachineId: opts.peerMachineId,
        sessionId: opts.sessionId,
      });
      const answer = await opts.signaling.pollForAnswer(opts.sessionId, { timeoutMs: POLL_TIMEOUT_MS, signal: opts.abortSignal });
      if (!answer) {
        cleanup("no_answer");
        return { ok: false, reason: "no_answer" };
      }
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } else {
      const offer = await opts.signaling.pollForOffer(opts.sessionId, { timeoutMs: POLL_TIMEOUT_MS, signal: opts.abortSignal });
      if (!offer) {
        cleanup("no_offer");
        return { ok: false, reason: "no_offer" };
      }
      await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await opts.signaling.writeAnswer(opts.sessionId, {
        kind: "answer",
        sdp: answer.sdp,
        fromMachineId: opts.myMachineId,
        toMachineId: opts.peerMachineId,
        sessionId: opts.sessionId,
      });
    }
  } catch (e) {
    cleanup("signaling_failed");
    return { ok: false, reason: "signaling_failed", detail: e instanceof Error ? e.message : String(e) };
  }

  // Drain peer's ICE candidates periodically; the signaling transport already
  // dedupes by candidate id, so re-applying is cheap.
  const seenIce = new Set<string>();
  iceDrainHandle = setInterval(() => {
    void opts.signaling.listIceFromPeer(opts.sessionId)
      .then((list) => {
        for (const ice of list) {
          if (ice.fromMachineId === opts.myMachineId) continue;
          const key = `${ice.candidate}:${ice.sdpMid ?? ""}:${String(ice.sdpMLineIndex ?? -1)}`;
          if (seenIce.has(key)) continue;
          seenIce.add(key);
          void pc.addIceCandidate({ candidate: ice.candidate, sdpMid: ice.sdpMid, sdpMLineIndex: ice.sdpMLineIndex }).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, ICE_DRAIN_INTERVAL_MS);

  // Wait for the data channel to open. Both sides converge here.
  let raw: P2PChannel;
  try {
    raw = await waitForOpenChannel(dataChannelPromise, pc, opts.abortSignal);
  } catch (e) {
    cleanup("channel_open_timeout");
    return {
      ok: false,
      reason: e instanceof Error && e.message === "aborted" ? "aborted" : "channel_open_timeout",
    };
  }

  clearInterval(iceDrainHandle);
  iceDrainHandle = null;
  machine.onConnected(Date.now());

  const authChannel = wrapAuthenticated(raw, opts.encryptionKey);

  // v2.12.3 — wrap channel with an idle tracker. `noteFrame` is called on
  // every authenticated frame (manifest / chunk / heartbeat). A periodic
  // 30s tick promotes warn → disconnect when threshold passes.
  const idle = createP2PIdleTracker({ startAtMs: Date.now() });
  const idleTickHandle = setInterval(() => {
    const decision = idle.evaluate(Date.now());
    if (decision === "disconnect") {
      machine.end(Date.now(), "idle_timeout");
      try { authChannel.close(); } catch { /* ignore */ }
      clearInterval(idleTickHandle);
    }
  }, IDLE_TICK_INTERVAL_MS);

  // Subscribe to authenticated frames just to feed the idle tracker. Caller
  // installs its own onFrame handler later for actual payload routing.
  authChannel.onFrame(
    () => { idle.noteFrame(Date.now()); },
    () => { /* reject paths handled elsewhere */ },
  );

  // v2.12.5 — fan out every state machine event to the caller (typically the
  // activity log). Drain the queue we already have, then keep checking on
  // the idle tick (cheap — events array shouldn't accumulate fast).
  let eventCursor = 0;
  const flushEvents = (): void => {
    const sink = opts.onSessionEvent;
    if (!sink) return;
    const events = machine.events;
    while (eventCursor < events.length) {
      sink(events[eventCursor]);
      eventCursor += 1;
    }
  };
  flushEvents();
  const eventTickHandle = setInterval(flushEvents, IDLE_TICK_INTERVAL_MS);

  const close = (): void => {
    clearInterval(idleTickHandle);
    clearInterval(eventTickHandle);
    cleanup("user_closed");
    try { authChannel.close(); } catch { /* ignore */ }
    flushEvents();
  };

  return { ok: true, channel: authChannel, machine, idle, close };
}

async function waitForOpenChannel(
  dcPromise: Promise<unknown>,
  pc: PeerConnectionLive,
  abort?: AbortSignal,
): Promise<P2PChannel> {
  const dcRaw = await Promise.race([
    dcPromise,
    new Promise((_, reject) => {
      if (abort) abort.addEventListener("abort", () => { reject(new Error("aborted")); }, { once: true });
    }),
  ]);
  const dc = dcRaw as { readyState: string; addEventListener: (t: string, h: () => void) => void; removeEventListener: (t: string, h: () => void) => void; send: (d: Uint8Array) => void; close: () => void; };
  if (dc.readyState === "open") return wrapChannel(dc as never, pc as never);
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => { dc.removeEventListener("open", onOpen); resolve(); };
    const onAbort = (): void => { reject(new Error("aborted")); };
    dc.addEventListener("open", onOpen);
    if (abort) abort.addEventListener("abort", onAbort, { once: true });
    setTimeout(() => { dc.removeEventListener("open", onOpen); reject(new Error("channel_open_timeout")); }, POLL_TIMEOUT_MS);
  });
  return wrapChannel(dc as never, pc as never);
}
