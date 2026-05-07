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
import { wrapChannel } from "../../src/core/p2pDataChannel.js";

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
