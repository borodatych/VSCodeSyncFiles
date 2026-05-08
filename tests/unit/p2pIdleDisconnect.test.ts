import { describe, expect, it } from "vitest";
import {
  createP2PIdleTracker,
  P2P_IDLE_DEFAULT_DISCONNECT_MS,
  P2P_IDLE_DEFAULT_WARN_MS,
} from "../../src/core/p2pIdleDisconnect.js";

describe("createP2PIdleTracker — defaults", () => {
  it("exposes 5-minute / 4-minute defaults", () => {
    const t = createP2PIdleTracker({ startAtMs: 0 });
    expect(t.disconnectAfterMs).toBe(P2P_IDLE_DEFAULT_DISCONNECT_MS);
    expect(t.warnAfterMs).toBe(P2P_IDLE_DEFAULT_WARN_MS);
    expect(P2P_IDLE_DEFAULT_DISCONNECT_MS).toBe(5 * 60 * 1000);
    expect(P2P_IDLE_DEFAULT_WARN_MS).toBe(4 * 60 * 1000);
  });

  it("rejects non-positive disconnectAfterMs", () => {
    expect(() => createP2PIdleTracker({ disconnectAfterMs: 0 })).toThrow();
    expect(() => createP2PIdleTracker({ disconnectAfterMs: -1 })).toThrow();
  });

  it("rejects warn >= disconnect or warn <= 0", () => {
    expect(() =>
      createP2PIdleTracker({ disconnectAfterMs: 1000, warnAfterMs: 1000 }),
    ).toThrow();
    expect(() =>
      createP2PIdleTracker({ disconnectAfterMs: 1000, warnAfterMs: 1001 }),
    ).toThrow();
    expect(() =>
      createP2PIdleTracker({ disconnectAfterMs: 1000, warnAfterMs: 0 }),
    ).toThrow();
  });
});

describe("createP2PIdleTracker — fresh window", () => {
  it("returns 'continue' until warn threshold", () => {
    const t = createP2PIdleTracker({
      disconnectAfterMs: 1000,
      warnAfterMs: 600,
      startAtMs: 0,
    });
    expect(t.evaluate(100)).toBe("continue");
    expect(t.evaluate(599)).toBe("continue");
    expect(t.state.kind).toBe("fresh");
  });

  it("noteFrame resets the idle clock", () => {
    const t = createP2PIdleTracker({
      disconnectAfterMs: 1000,
      warnAfterMs: 600,
      startAtMs: 0,
    });
    t.evaluate(700); // would warn
    t.noteFrame(800);
    expect(t.evaluate(900)).toBe("continue");
    expect(t.state.kind).toBe("fresh");
  });
});

describe("createP2PIdleTracker — warn window", () => {
  it("emits 'warn' once when crossing warnAfterMs", () => {
    const t = createP2PIdleTracker({
      disconnectAfterMs: 1000,
      warnAfterMs: 600,
      startAtMs: 0,
    });
    expect(t.evaluate(700)).toBe("warn");
    expect(t.state.kind).toBe("warned");
  });

  it("subsequent evaluate calls in the same idle window return 'continue'", () => {
    const t = createP2PIdleTracker({
      disconnectAfterMs: 1000,
      warnAfterMs: 600,
      startAtMs: 0,
    });
    expect(t.evaluate(700)).toBe("warn");
    expect(t.evaluate(800)).toBe("continue");
    expect(t.evaluate(900)).toBe("continue");
  });

  it("re-arms warn after a noteFrame() reset", () => {
    const t = createP2PIdleTracker({
      disconnectAfterMs: 1000,
      warnAfterMs: 600,
      startAtMs: 0,
    });
    expect(t.evaluate(700)).toBe("warn");
    t.noteFrame(800);
    expect(t.evaluate(1500)).toBe("warn");
  });
});

describe("createP2PIdleTracker — disconnect window", () => {
  it("emits 'disconnect' once when crossing disconnectAfterMs", () => {
    const t = createP2PIdleTracker({
      disconnectAfterMs: 1000,
      warnAfterMs: 600,
      startAtMs: 0,
    });
    expect(t.evaluate(1000)).toBe("disconnect");
    expect(t.state.kind).toBe("disconnected");
  });

  it("subsequent ticks after disconnect return 'continue' (idempotent)", () => {
    const t = createP2PIdleTracker({
      disconnectAfterMs: 1000,
      warnAfterMs: 600,
      startAtMs: 0,
    });
    expect(t.evaluate(1000)).toBe("disconnect");
    expect(t.evaluate(1100)).toBe("continue");
    expect(t.evaluate(99_999)).toBe("continue");
  });

  it("disconnect can fire even if warn was never observed (no tick in warn window)", () => {
    const t = createP2PIdleTracker({
      disconnectAfterMs: 1000,
      warnAfterMs: 600,
      startAtMs: 0,
    });
    // Skip the warn window entirely.
    expect(t.evaluate(1500)).toBe("disconnect");
  });

  it("re-arms after noteFrame reset (post-disconnect)", () => {
    const t = createP2PIdleTracker({
      disconnectAfterMs: 1000,
      warnAfterMs: 600,
      startAtMs: 0,
    });
    expect(t.evaluate(1000)).toBe("disconnect");
    t.noteFrame(1100);
    expect(t.state.kind).toBe("fresh");
    expect(t.evaluate(1700)).toBe("warn");
    expect(t.evaluate(2100)).toBe("disconnect");
  });
});

describe("createP2PIdleTracker — boundary conditions", () => {
  it("idle == warnAfterMs exactly is treated as warn (>=)", () => {
    const t = createP2PIdleTracker({
      disconnectAfterMs: 1000,
      warnAfterMs: 600,
      startAtMs: 0,
    });
    expect(t.evaluate(600)).toBe("warn");
  });

  it("idle == disconnectAfterMs exactly is treated as disconnect (>=)", () => {
    const t = createP2PIdleTracker({
      disconnectAfterMs: 1000,
      warnAfterMs: 600,
      startAtMs: 0,
    });
    expect(t.evaluate(1000)).toBe("disconnect");
  });
});
