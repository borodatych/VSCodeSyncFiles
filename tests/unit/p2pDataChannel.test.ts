/**
 * Tests for the P2P data-channel wrapper. Uses fake `RTCDataChannel` and
 * `RTCPeerConnection` shims so we don't bring up the native WebRTC stack
 * (which would need actual ICE traffic). Covers:
 *   - send while open succeeds
 *   - send while not-open throws
 *   - onMessage receives ArrayBuffer / Uint8Array / typed-array views
 *   - close is idempotent
 */
import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { wrapAuthenticated, wrapChannel } from "../../src/core/p2pDataChannel.js";
import { encodeP2PFrame } from "../../src/core/p2pCryptoEnvelope.js";

interface FakeDataChannel {
  readyState: "connecting" | "open" | "closing" | "closed";
  send: (data: Uint8Array) => void;
  close: () => void;
  addEventListener: (type: "message", listener: (ev: { data: unknown }) => void) => void;
  removeEventListener: (type: "message", listener: (ev: { data: unknown }) => void) => void;
  fire: (data: unknown) => void;
}

function fakeChannel(state: "connecting" | "open" | "closing" | "closed" = "open"): FakeDataChannel {
  const listeners = new Set<(ev: { data: unknown }) => void>();
  let st = state;
  return {
    get readyState(): "connecting" | "open" | "closing" | "closed" {
      return st;
    },
    set readyState(v: "connecting" | "open" | "closing" | "closed") {
      st = v;
    },
    send: vi.fn(),
    close: vi.fn(() => { st = "closed"; }),
    addEventListener: (_t, l) => { listeners.add(l); },
    removeEventListener: (_t, l) => { listeners.delete(l); },
    fire: (data) => {
      for (const l of listeners) l({ data });
    },
  };
}

function fakePc(): { close: ReturnType<typeof vi.fn>; createDataChannel: ReturnType<typeof vi.fn> } {
  return {
    close: vi.fn(),
    createDataChannel: vi.fn(),
  };
}

describe("wrapChannel", () => {
  it("send while open delegates to the underlying channel", () => {
    const ch = fakeChannel("open");
    const pc = fakePc();
    const w = wrapChannel(ch, pc);
    const buf = new Uint8Array([1, 2, 3]);
    w.send(buf);
    expect(ch.send).toHaveBeenCalledWith(buf);
  });

  it("send throws when channel is not open", () => {
    const ch = fakeChannel("connecting");
    const w = wrapChannel(ch, fakePc());
    expect(() => { w.send(new Uint8Array([1])); }).toThrow(/not open/);
  });

  it("send throws after close (closed state)", () => {
    const ch = fakeChannel("open");
    const pc = fakePc();
    const w = wrapChannel(ch, pc);
    w.close();
    expect(() => { w.send(new Uint8Array([1])); }).toThrow(/closed/);
    expect(ch.close).toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalled();
  });

  it("close is idempotent", () => {
    const ch = fakeChannel("open");
    const pc = fakePc();
    const w = wrapChannel(ch, pc);
    w.close();
    w.close();
    expect(ch.close).toHaveBeenCalledTimes(1);
    expect(pc.close).toHaveBeenCalledTimes(1);
  });

  it("onMessage receives ArrayBuffer payloads", () => {
    const ch = fakeChannel("open");
    const w = wrapChannel(ch, fakePc());
    const received: Uint8Array[] = [];
    w.onMessage((d) => { received.push(d); });
    const buf = new ArrayBuffer(3);
    new Uint8Array(buf).set([7, 8, 9]);
    ch.fire(buf);
    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([7, 8, 9]);
  });

  it("onMessage receives Uint8Array payloads", () => {
    const ch = fakeChannel("open");
    const w = wrapChannel(ch, fakePc());
    const received: Uint8Array[] = [];
    w.onMessage((d) => { received.push(d); });
    ch.fire(new Uint8Array([1, 2, 3]));
    expect(Array.from(received[0])).toEqual([1, 2, 3]);
  });

  it("onMessage disposer detaches the listener", () => {
    const ch = fakeChannel("open");
    const w = wrapChannel(ch, fakePc());
    const received: Uint8Array[] = [];
    const off = w.onMessage((d) => { received.push(d); });
    off();
    ch.fire(new Uint8Array([1]));
    expect(received).toHaveLength(0);
  });

  it("isOpen reflects channel state and close()", () => {
    const ch = fakeChannel("open");
    const w = wrapChannel(ch, fakePc());
    expect(w.isOpen()).toBe(true);
    w.close();
    expect(w.isOpen()).toBe(false);
  });
});

describe("wrapAuthenticated", () => {
  const KEY = randomBytes(32);

  it("sendFrame encodes with monotonic seq starting at 0", () => {
    const ch = fakeChannel("open");
    const w = wrapChannel(ch, fakePc());
    const auth = wrapAuthenticated(w, KEY);
    auth.sendFrame("file_chunk", Buffer.from("first"));
    auth.sendFrame("ack", Buffer.from("second"));
    const sendMock = ch.send as unknown as { mock: { calls: [Uint8Array][] } };
    expect(sendMock.mock.calls).toHaveLength(2);
    // header bytes 2..6 (LE u32) hold seq
    expect(Buffer.from(sendMock.mock.calls[0][0]).readUInt32LE(2)).toBe(0);
    expect(Buffer.from(sendMock.mock.calls[1][0]).readUInt32LE(2)).toBe(1);
  });

  it("onFrame decodes inbound and increments expectedInSeq", () => {
    const ch = fakeChannel("open");
    const w = wrapChannel(ch, fakePc());
    const auth = wrapAuthenticated(w, KEY);
    const got: { type: string; seq: number; payload: string }[] = [];
    auth.onFrame((type, seq, payload) => {
      got.push({ type, seq, payload: payload.toString() });
    });
    const f0 = encodeP2PFrame(KEY, { type: "manifest", seq: 0, payload: Buffer.from("m0") });
    const f1 = encodeP2PFrame(KEY, { type: "ack", seq: 1, payload: Buffer.from("a1") });
    ch.fire(f0.buffer.slice(f0.byteOffset, f0.byteOffset + f0.byteLength));
    ch.fire(f1.buffer.slice(f1.byteOffset, f1.byteOffset + f1.byteLength));
    expect(got).toEqual([
      { type: "manifest", seq: 0, payload: "m0" },
      { type: "ack", seq: 1, payload: "a1" },
    ]);
  });

  it("onFrame routes replays / out-of-order to onReject", () => {
    const ch = fakeChannel("open");
    const w = wrapChannel(ch, fakePc());
    const auth = wrapAuthenticated(w, KEY);
    const got: number[] = [];
    const rejected: string[] = [];
    auth.onFrame(
      (_t, seq) => { got.push(seq); },
      (reason) => { rejected.push(reason); },
    );
    const f0 = encodeP2PFrame(KEY, { type: "ack", seq: 0, payload: Buffer.alloc(0) });
    const fReplay = encodeP2PFrame(KEY, { type: "ack", seq: 0, payload: Buffer.alloc(0) });
    ch.fire(f0.buffer.slice(f0.byteOffset, f0.byteOffset + f0.byteLength));
    ch.fire(fReplay.buffer.slice(fReplay.byteOffset, fReplay.byteOffset + fReplay.byteLength));
    expect(got).toEqual([0]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("seq mismatch");
  });

  it("onFrame routes authTag-failure inbound to onReject", () => {
    const ch = fakeChannel("open");
    const w = wrapChannel(ch, fakePc());
    const auth = wrapAuthenticated(w, KEY);
    const rejected: string[] = [];
    auth.onFrame(
      () => { /* noop */ },
      (reason) => { rejected.push(reason); },
    );
    const wrongKey = randomBytes(32);
    const tampered = encodeP2PFrame(wrongKey, { type: "ack", seq: 0, payload: Buffer.alloc(0) });
    ch.fire(tampered.buffer.slice(tampered.byteOffset, tampered.byteOffset + tampered.byteLength));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("decrypt failed");
  });

  it("close clears seq counters and unsubscribes", () => {
    const ch = fakeChannel("open");
    const w = wrapChannel(ch, fakePc());
    const auth = wrapAuthenticated(w, KEY);
    let received = 0;
    auth.onFrame(() => { received++; });
    auth.close();
    const f = encodeP2PFrame(KEY, { type: "ack", seq: 0, payload: Buffer.alloc(0) });
    ch.fire(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength));
    expect(received).toBe(0);
  });

  it("isOpen delegates to underlying channel", () => {
    const ch = fakeChannel("open");
    const w = wrapChannel(ch, fakePc());
    const auth = wrapAuthenticated(w, KEY);
    expect(auth.isOpen()).toBe(true);
    auth.close();
    expect(auth.isOpen()).toBe(false);
  });
});
