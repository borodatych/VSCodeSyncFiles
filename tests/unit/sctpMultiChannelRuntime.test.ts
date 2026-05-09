/**
 * v2.20.2 — multi-DataChannel SCTP runtime tests with stub RTC factory.
 */
import { describe, expect, it } from "vitest";
import {
  createMultiChannelSctpRuntime,
  decodeRuntimeFrame,
  encodeRuntimeFrame,
  type RTCDataChannelLike,
  type RTCPeerConnectionLike,
} from "../../src/core/sctpMultiChannelRuntime.js";

function makeStubChannel(id: number): RTCDataChannelLike {
  let onmessage: ((ev: { data: ArrayBuffer | Uint8Array }) => void) | null = null;
  return {
    id,
    readyState: "open",
    send(_data) {
      // tests inspect via the peer wrapper instead.
    },
    close() {
      this.readyState = "closed";
    },
    set onmessage(fn) { onmessage = fn; },
    get onmessage() { return onmessage; },
  };
}

function makeStubPeer(_lanes: number): RTCPeerConnectionLike & { channels: RTCDataChannelLike[]; sent: { lane: number; data: Uint8Array }[] } {
  const channels: RTCDataChannelLike[] = [];
  const sent: { lane: number; data: Uint8Array }[] = [];
  return {
    channels,
    sent,
    createDataChannel(_label, init): RTCDataChannelLike {
      const id = init?.id ?? channels.length;
      const ch = makeStubChannel(id);
      const laneIdx = id;
      ch.send = (data): void => {
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        sent.push({ lane: laneIdx, data: u8 });
      };
      channels.push(ch);
      return ch;
    },
    close(): void {
      for (const ch of channels) ch.close();
    },
  };
}

describe("createMultiChannelSctpRuntime", () => {
  it("opens N stable channels with id 0..N-1", () => {
    const peer = makeStubPeer(3);
    const rt = createMultiChannelSctpRuntime({ lanes: 3, peer });
    expect(rt.lanes).toBe(3);
    expect(peer.channels.map((c) => c.id)).toEqual([0, 1, 2]);
  });

  it("rejects lanes < 1", () => {
    expect(() => createMultiChannelSctpRuntime({ lanes: 0, peer: makeStubPeer(0) }))
      .toThrow();
  });

  it("manifest payloads always go to lane 0", async () => {
    const peer = makeStubPeer(4);
    const rt = createMultiChannelSctpRuntime({ lanes: 4, peer });
    await rt.send({ kind: "manifest", payload: new Uint8Array([1, 2, 3]) });
    expect(peer.sent).toHaveLength(1);
    expect(peer.sent[0]?.lane).toBe(0);
  });

  it("file_chunk with same stableKey lands on the same lane", async () => {
    const peer = makeStubPeer(4);
    const rt = createMultiChannelSctpRuntime({ lanes: 4, peer });
    await rt.send({ kind: "file_chunk", stableKey: "fileA", payload: new Uint8Array([1]) });
    await rt.send({ kind: "file_chunk", stableKey: "fileA", payload: new Uint8Array([2]) });
    expect(peer.sent).toHaveLength(2);
    expect(peer.sent[0]?.lane).toBe(peer.sent[1]?.lane);
  });

  it("rejects send when lane is not open", async () => {
    const peer = makeStubPeer(2);
    const rt = createMultiChannelSctpRuntime({ lanes: 2, peer });
    peer.channels[0].readyState = "connecting";
    await expect(rt.send({ kind: "manifest", payload: new Uint8Array() })).rejects.toThrow(/not open/);
  });

  it("onFrame fans out inbound frames with lane index", () => {
    const peer = makeStubPeer(3);
    const rt = createMultiChannelSctpRuntime({ lanes: 3, peer });
    const events: number[] = [];
    rt.onFrame((f) => events.push(f.lane));
    const wire = encodeRuntimeFrame({ kind: "manifest", payload: new Uint8Array([42]) });
    peer.channels[1].onmessage?.({ data: wire });
    expect(events).toEqual([1]);
  });

  it("onFrame ignores malformed inbound", () => {
    const peer = makeStubPeer(2);
    const rt = createMultiChannelSctpRuntime({ lanes: 2, peer });
    const events: unknown[] = [];
    rt.onFrame((f) => events.push(f));
    peer.channels[0].onmessage?.({ data: new Uint8Array([99]) }); // too short
    expect(events).toEqual([]);
  });

  it("close tears down channels + peer + subscribers", async () => {
    const peer = makeStubPeer(2);
    const rt = createMultiChannelSctpRuntime({ lanes: 2, peer });
    rt.onFrame(() => { /* unused */ });
    await rt.close();
    expect(peer.channels.every((c) => c.readyState === "closed")).toBe(true);
  });
});

describe("encode/decodeRuntimeFrame", () => {
  it("round-trips kind + payload", () => {
    const f = encodeRuntimeFrame({ kind: "control", payload: new Uint8Array([1, 2, 3]) });
    const r = decodeRuntimeFrame(f);
    expect(r?.kind).toBe("control");
    expect(Array.from(r!.payload)).toEqual([1, 2, 3]);
  });
  it("rejects bad version", () => {
    expect(decodeRuntimeFrame(new Uint8Array([99, 1]))).toBeNull();
  });
  it("rejects unknown kind code", () => {
    expect(decodeRuntimeFrame(new Uint8Array([1, 250]))).toBeNull();
  });
  it("rejects too-short buffer", () => {
    expect(decodeRuntimeFrame(new Uint8Array([1]))).toBeNull();
  });
});
