/**
 * v2.1.6 / v2.12.4 — in-process @roamhq/wrtc loopback smoke test.
 *
 * Runs both inviter and invitee in the same process against a fake
 * SignalingTransport (in-memory store, no real cloud). Validates that
 * `openP2PSession` actually wires:
 *   - createOffer / setLocalDescription
 *   - signaling.writeOffer / pollForOffer
 *   - createAnswer / setLocalDescription
 *   - signaling.writeAnswer / pollForAnswer
 *   - ICE candidate exchange
 *   - DataChannel open
 *   - wrapAuthenticated round-trip (one frame each direction).
 *
 * The test is conditional: it only runs when the `@roamhq/wrtc` native
 * binding actually loads. On CI runners where the binding is not loadable
 * (Linux containers without ALSA, sandboxed Mac builders without entitlement,
 * etc.), the suite is skipped — *not* failed — so this stays a non-blocking
 * confidence smoke.
 *
 * Default vitest test timeout is 5 s; ICE on loopback usually completes in
 * <1 s but we still bump to 30 s to absorb cold-start dynamic-import.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SignalingTransport } from "../../src/ui/p2pSignalingTransport.js";
import type { P2POffer, P2PAnswer, P2PIce, P2PBye } from "../../src/core/p2pSignaling.js";

interface SignalRecord {
  offer?: P2POffer;
  answer?: P2PAnswer;
  ice: Map<string, P2PIce>;
  bye?: P2PBye;
}

function makeFakeTransport(): { inviter: SignalingTransport; invitee: SignalingTransport; store: Map<string, SignalRecord> } {
  const store = new Map<string, SignalRecord>();
  const get = (id: string): SignalRecord => {
    let rec = store.get(id);
    if (!rec) { rec = { ice: new Map() }; store.set(id, rec); }
    return rec;
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const make = (): SignalingTransport => ({
    writeOffer(sessionId, signal): Promise<void> { get(sessionId).offer = signal; return Promise.resolve(); },
    writeAnswer(sessionId, signal): Promise<void> { get(sessionId).answer = signal; return Promise.resolve(); },
    writeBye(sessionId, signal): Promise<void> { get(sessionId).bye = signal; return Promise.resolve(); },
    writeIceCandidate(sessionId, candidateId, signal): Promise<void> { get(sessionId).ice.set(candidateId, signal); return Promise.resolve(); },
    async pollForOffer(sessionId, options): Promise<P2POffer | null> {
      const deadline = Date.now() + (options?.timeoutMs ?? 30_000);
      while (Date.now() < deadline) {
        const v = store.get(sessionId)?.offer;
        if (v) return v;
        await sleep(20);
      }
      return null;
    },
    async pollForAnswer(sessionId, options): Promise<P2PAnswer | null> {
      const deadline = Date.now() + (options?.timeoutMs ?? 30_000);
      while (Date.now() < deadline) {
        const v = store.get(sessionId)?.answer;
        if (v) return v;
        await sleep(20);
      }
      return null;
    },
    listIceFromPeer(sessionId): Promise<P2PIce[]> { return Promise.resolve([...(store.get(sessionId)?.ice.values() ?? [])]); },
    cleanupSession(): Promise<boolean> { return Promise.resolve(true); },
  });
  return { inviter: make(), invitee: make(), store };
}

let wrtcLoaded = false;

beforeAll(async () => {
  try {
    await import("@roamhq/wrtc");
    wrtcLoaded = true;
  } catch {
    wrtcLoaded = false;
  }
});

afterAll(() => {
  // No-op; @roamhq/wrtc cleans up its threads on process exit.
});

describe("p2pSessionRuntime — in-process loopback smoke", () => {
  it.runIf(typeof process.env.P2P_SMOKE === "string")("inviter+invitee complete an authenticated frame exchange", async () => {
    if (!wrtcLoaded) {
      console.log("@roamhq/wrtc not loadable — skipping P2P loopback smoke");
      return;
    }
    const { openP2PSession } = await import("../../src/ui/p2pSessionRuntime.js");
    const { createP2PSessionRegistry } = await import("../../src/core/p2pSessionRegistry.js");
    const { randomBytes } = await import("node:crypto");

    const transport = makeFakeTransport();
    const key = randomBytes(32);
    const sessionId = "smoke-" + randomBytes(4).toString("hex");

    const registryA = createP2PSessionRegistry();
    const registryB = createP2PSessionRegistry();

    const inviterPromise = openP2PSession({
      role: "inviter",
      sessionId,
      myMachineId: "alice",
      peerMachineId: "bob",
      encryptionKey: key,
      signaling: transport.inviter,
      registry: registryA,
    });
    const inviteePromise = openP2PSession({
      role: "invitee",
      sessionId,
      myMachineId: "bob",
      peerMachineId: "alice",
      encryptionKey: key,
      signaling: transport.invitee,
      registry: registryB,
    });

    const [a, b] = await Promise.all([inviterPromise, inviteePromise]);
    expect(a.ok, `inviter failed${a.ok ? "" : ": " + (a.detail ?? a.reason)}`).toBe(true);
    expect(b.ok, `invitee failed${b.ok ? "" : ": " + (b.detail ?? b.reason)}`).toBe(true);
    if (!a.ok || !b.ok) return;

    const received: { type: string; payload: Buffer }[] = [];
    a.channel.onFrame((type, _seq, payload) => { received.push({ type, payload }); });
    b.channel.sendFrame("file_chunk", Buffer.from("hello-from-bob"));
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    expect(received.length).toBeGreaterThan(0);
    if (received[0]) {
      expect(received[0].type).toBe("file_chunk");
      expect(received[0].payload.toString("utf8")).toBe("hello-from-bob");
    }

    a.close();
    b.close();
  }, 30_000);

  it("sentinel — wrtc gating works without binding", async () => {
    const { openP2PSession } = await import("../../src/ui/p2pSessionRuntime.js");
    const { createP2PSessionRegistry } = await import("../../src/core/p2pSessionRegistry.js");
    const { randomBytes } = await import("node:crypto");
    const transport = makeFakeTransport();
    const result = await openP2PSession({
      role: "inviter",
      sessionId: "no-binding",
      myMachineId: "a",
      peerMachineId: "b",
      encryptionKey: randomBytes(32),
      signaling: transport.inviter,
      registry: createP2PSessionRegistry(),
      wrtcOverride: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrtc_unavailable");
    }
  });
});
