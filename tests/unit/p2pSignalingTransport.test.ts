import { describe, expect, it } from "vitest";
import {
  createSignalingTransport,
  SignalingNotWritableError,
} from "../../src/ui/p2pSignalingTransport.js";
import {
  buildIceCandidateEnvelope,
  buildSignalingEnvelope,
  cloudPathForIceCandidate,
  cloudPathForSignaling,
} from "../../src/core/p2pSignalingChannel.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";
import type {
  ICloudProvider,
  FileMetadata,
} from "../../src/providers/cloudProviderTypes.js";
import type { P2POffer, P2PAnswer, P2PIce, P2PBye } from "../../src/core/p2pSignaling.js";

const SID = "sess-12345678";
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function makeFakeProvider(): ICloudProvider & { _files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  const p: ICloudProvider & { _files: Map<string, Buffer> } = {
    type: "onedrive",
    _files: files,
    isAuthenticated: () => Promise.resolve(true),
    authenticate: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    uploadFile: (cloudPath, content) => {
      files.set(cloudPath, Buffer.from(content));
      return Promise.resolve({ etag: "fake" });
    },
    downloadFile: (cloudPath) => {
      const body = files.get(cloudPath);
      if (!body) return Promise.reject(new ProviderError("NOT_FOUND", "missing"));
      return Promise.resolve({ body });
    },
    getMetadata: () => Promise.resolve(null),
    deleteFile: (cloudPath) => {
      files.delete(cloudPath);
      return Promise.resolve();
    },
    listFolder: (cloudPath) => {
      const prefix = `${cloudPath}/`;
      const out: FileMetadata[] = [];
      for (const [k, v] of files) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest.includes("/")) continue;
        out.push({ cloudPath: k, size: v.byteLength });
      }
      return Promise.resolve(out);
    },
    createFolder: () => Promise.resolve(),
  };
  return p;
}

function offer(): P2POffer {
  return { kind: "offer", sdp: "v=0\n", fromMachineId: "A", toMachineId: "B", sessionId: SID };
}
function answer(): P2PAnswer {
  return { kind: "answer", sdp: "v=0\n", fromMachineId: "B", toMachineId: "A", sessionId: SID };
}
function ice(suffix: string): P2PIce {
  return {
    kind: "ice",
    candidate: `candidate:${suffix}`,
    sdpMid: "0",
    sdpMLineIndex: 0,
    fromMachineId: "A",
    toMachineId: "B",
    sessionId: SID,
  };
}
function bye(): P2PBye {
  return { kind: "bye", fromMachineId: "A", toMachineId: "B", sessionId: SID };
}

describe("createSignalingTransport — read-only protection", () => {
  it("throws SignalingNotWritableError on any write", async () => {
    const provider = makeFakeProvider();
    const t = createSignalingTransport({ provider, workspaceWritable: false });
    await expect(t.writeOffer(SID, offer())).rejects.toBeInstanceOf(SignalingNotWritableError);
    await expect(t.writeAnswer(SID, answer())).rejects.toBeInstanceOf(SignalingNotWritableError);
    await expect(t.writeIceCandidate(SID, "c1", ice("1"))).rejects.toBeInstanceOf(
      SignalingNotWritableError,
    );
    await expect(t.writeBye(SID, bye())).rejects.toBeInstanceOf(SignalingNotWritableError);
  });
});

describe("createSignalingTransport — writes use channel paths", () => {
  it("writeOffer / writeAnswer / writeBye land on expected cloud paths", async () => {
    const provider = makeFakeProvider();
    const t = createSignalingTransport({
      provider,
      workspaceWritable: true,
      now: () => NOW,
    });
    await t.writeOffer(SID, offer());
    await t.writeAnswer(SID, answer());
    await t.writeBye(SID, bye());
    expect(provider._files.has(cloudPathForSignaling(SID, "offer"))).toBe(true);
    expect(provider._files.has(cloudPathForSignaling(SID, "answer"))).toBe(true);
    expect(provider._files.has(cloudPathForSignaling(SID, "bye"))).toBe(true);
  });

  it("writeIceCandidate places blob at _p2p/{sid}/ice/{cid}.json", async () => {
    const provider = makeFakeProvider();
    const t = createSignalingTransport({ provider, workspaceWritable: true, now: () => NOW });
    await t.writeIceCandidate(SID, "c1", ice("1"));
    expect(provider._files.has(cloudPathForIceCandidate(SID, "c1"))).toBe(true);
  });
});

describe("createSignalingTransport — pollForOffer / pollForAnswer", () => {
  it("returns the offer after a single retry loop iteration", async () => {
    const provider = makeFakeProvider();
    // Pre-populate storage with a fresh offer envelope.
    const env = buildSignalingEnvelope(SID, "offer", offer(), NOW);
    provider._files.set(
      cloudPathForSignaling(SID, "offer"),
      Buffer.from(JSON.stringify(env), "utf8"),
    );
    const t = createSignalingTransport({ provider, workspaceWritable: false, now: () => NOW });
    const sleep = (): Promise<void> => Promise.resolve();
    const result = await t.pollForOffer(SID, { sleep, timeoutMs: 1000 });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("offer");
  });

  it("times out and returns null when no answer ever appears", async () => {
    const provider = makeFakeProvider();
    let virtualNow = NOW;
    const sleep = (ms: number): Promise<void> => {
      virtualNow += ms;
      return Promise.resolve();
    };
    const t = createSignalingTransport({
      provider,
      workspaceWritable: false,
      now: () => virtualNow,
    });
    const result = await t.pollForAnswer(SID, { sleep, timeoutMs: 5_000, maxDelayMs: 1_000 });
    expect(result).toBeNull();
  });

  it("ignores stale envelopes (past TTL)", async () => {
    const provider = makeFakeProvider();
    const env = buildSignalingEnvelope(SID, "offer", offer(), NOW);
    provider._files.set(
      cloudPathForSignaling(SID, "offer"),
      Buffer.from(JSON.stringify(env), "utf8"),
    );
    let virtualNow = NOW + 120_000; // far past 60s TTL
    const sleep = (ms: number): Promise<void> => {
      virtualNow += ms;
      return Promise.resolve();
    };
    const t = createSignalingTransport({
      provider,
      workspaceWritable: false,
      now: () => virtualNow,
    });
    const result = await t.pollForOffer(SID, { sleep, timeoutMs: 2_000 });
    expect(result).toBeNull();
  });
});

describe("createSignalingTransport — listIceFromPeer", () => {
  it("returns ICE candidates uploaded under _p2p/{sid}/ice/", async () => {
    const provider = makeFakeProvider();
    for (const cid of ["c1", "c2", "c3"]) {
      const env = buildIceCandidateEnvelope(SID, cid, ice(cid), NOW);
      provider._files.set(
        cloudPathForIceCandidate(SID, cid),
        Buffer.from(JSON.stringify(env), "utf8"),
      );
    }
    const t = createSignalingTransport({ provider, workspaceWritable: false, now: () => NOW });
    const list = await t.listIceFromPeer(SID);
    expect(list).toHaveLength(3);
    expect(list.every((c) => c.candidate.startsWith("candidate:"))).toBe(true);
  });

  it("returns empty list if folder does not exist (NOT_FOUND)", async () => {
    const provider = makeFakeProvider();
    provider.listFolder = () => Promise.reject(new ProviderError("NOT_FOUND", "missing"));
    const t = createSignalingTransport({ provider, workspaceWritable: false, now: () => NOW });
    const list = await t.listIceFromPeer(SID);
    expect(list).toEqual([]);
  });
});

describe("createSignalingTransport — cleanupSession", () => {
  it("does nothing if not idle for long enough", async () => {
    const provider = makeFakeProvider();
    provider._files.set(cloudPathForSignaling(SID, "offer"), Buffer.from("{}"));
    const t = createSignalingTransport({ provider, workspaceWritable: false, now: () => NOW });
    const cleaned = await t.cleanupSession(SID, NOW - 1000, NOW);
    expect(cleaned).toBe(false);
    expect(provider._files.size).toBe(1);
  });

  it("deletes all session blobs when idle past threshold", async () => {
    const provider = makeFakeProvider();
    provider._files.set(cloudPathForSignaling(SID, "offer"), Buffer.from("{}"));
    provider._files.set(cloudPathForSignaling(SID, "bye"), Buffer.from("{}"));
    const t = createSignalingTransport({ provider, workspaceWritable: false, now: () => NOW });
    const cleaned = await t.cleanupSession(SID, NOW - 6 * 60_000, NOW);
    expect(cleaned).toBe(true);
    expect(provider._files.size).toBe(0);
  });
});
