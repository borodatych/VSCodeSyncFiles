import { describe, expect, it } from "vitest";
import { formatP2PStatusBar } from "../../src/core/p2pStatusBarFormatter.js";
import type { P2PSessionState } from "../../src/core/p2pSessionStateMachine.js";

const NOW = 1_700_000_000_000;

function snap(
  state: P2PSessionState,
  overrides: { transport?: "cloud" | "qr"; peerCount?: number; peerLabel?: string } = {},
) {
  return {
    state,
    transport: overrides.transport ?? "cloud",
    peerCount: overrides.peerCount ?? 1,
    peerLabel: overrides.peerLabel,
  } as const;
}

describe("formatP2PStatusBar — off / idle", () => {
  it("returns off-state when snapshot is undefined", () => {
    const r = formatP2PStatusBar(undefined);
    expect(r.text).toBe("$(broadcast) P2P: off");
    expect(r.severity).toBe("off");
    expect(r.commandId).toBe("vscodesync.showP2PSessionStatus");
  });

  it("returns off-state when state.kind === 'idle'", () => {
    const r = formatP2PStatusBar(snap({ kind: "idle" }));
    expect(r.text).toBe("$(broadcast) P2P: off");
    expect(r.severity).toBe("off");
  });

  it("respects a caller-supplied commandId override", () => {
    const r = formatP2PStatusBar(undefined, { commandId: "vscodesync.foo" });
    expect(r.commandId).toBe("vscodesync.foo");
  });
});

describe("formatP2PStatusBar — connected", () => {
  it("uses $(broadcast) icon and renders peer count + alpha tag", () => {
    const r = formatP2PStatusBar(
      snap({ kind: "connected", sinceMs: NOW - 5_000, lastHeartbeatAtMs: NOW - 2_000 }),
      { now: NOW },
    );
    expect(r.text).toBe("$(broadcast) P2P: 1 peer (alpha)");
    expect(r.severity).toBe("ok");
  });

  it("pluralises peers when count != 1", () => {
    const r = formatP2PStatusBar(
      snap(
        { kind: "connected", sinceMs: NOW - 1000, lastHeartbeatAtMs: NOW - 500 },
        { peerCount: 2 },
      ),
      { now: NOW },
    );
    expect(r.text).toBe("$(broadcast) P2P: 2 peers (alpha)");
  });

  it("renders uptime + last heartbeat in tooltip", () => {
    const r = formatP2PStatusBar(
      snap({
        kind: "connected",
        sinceMs: NOW - (2 * 60 + 5) * 1000,
        lastHeartbeatAtMs: NOW - 30_000,
      }),
      { now: NOW },
    );
    expect(r.tooltip).toContain("Uptime");
    expect(r.tooltip).toContain("2m 5s");
    expect(r.tooltip).toContain("Last heartbeat");
    expect(r.tooltip).toContain("30s ago");
  });

  it("includes peer label when supplied", () => {
    const r = formatP2PStatusBar(
      snap(
        { kind: "connected", sinceMs: NOW, lastHeartbeatAtMs: NOW },
        { peerLabel: "alice-laptop" },
      ),
      { now: NOW },
    );
    expect(r.tooltip).toContain("**Peer:** alice-laptop");
  });

  it("omits peer label line when not supplied or empty", () => {
    const r = formatP2PStatusBar(
      snap(
        { kind: "connected", sinceMs: NOW, lastHeartbeatAtMs: NOW },
        { peerLabel: "" },
      ),
      { now: NOW },
    );
    expect(r.tooltip).not.toContain("**Peer:**");
  });
});

describe("formatP2PStatusBar — connecting / reconnecting", () => {
  it("escalates to warn during 'connecting' with sync~spin icon", () => {
    const r = formatP2PStatusBar(snap({ kind: "connecting", sinceMs: NOW - 1000 }), { now: NOW });
    expect(r.severity).toBe("warn");
    expect(r.text).toContain("$(sync~spin)");
    expect(r.text).toContain("connecting");
  });

  it("escalates to warn during 'reconnecting' and shows attempt + next delay", () => {
    const r = formatP2PStatusBar(
      snap({ kind: "reconnecting", sinceMs: NOW, attempt: 2, nextDelayMs: 4_000 }),
      { now: NOW },
    );
    expect(r.severity).toBe("warn");
    expect(r.text).toBe("$(sync~spin) P2P: reconnecting (#2)");
    expect(r.tooltip).toContain("**Attempt:** 2");
    expect(r.tooltip).toContain("Next retry in");
    expect(r.tooltip).toContain("4s");
  });
});

describe("formatP2PStatusBar — disconnected", () => {
  it("escalates to error and surfaces the reason", () => {
    const r = formatP2PStatusBar(
      snap({ kind: "disconnected", sinceMs: NOW, reason: "transport_closed" }),
      { now: NOW },
    );
    expect(r.severity).toBe("error");
    expect(r.text).toBe("$(error) P2P: disconnected");
    expect(r.tooltip).toContain("**Reason:** transport_closed");
  });
});

describe("formatP2PStatusBar — transport label", () => {
  it("renders 'cloud signaling' tooltip when transport is cloud", () => {
    const r = formatP2PStatusBar(snap({ kind: "connecting", sinceMs: NOW }), { now: NOW });
    expect(r.tooltip).toContain("cloud signaling");
  });

  it("renders 'QR signaling' tooltip when transport is qr", () => {
    const r = formatP2PStatusBar(
      snap({ kind: "connecting", sinceMs: NOW }, { transport: "qr" }),
      { now: NOW },
    );
    expect(r.tooltip).toContain("QR signaling");
  });
});

describe("formatP2PStatusBar — duration formatting", () => {
  it("clamps negative durations to 0s", () => {
    const r = formatP2PStatusBar(
      snap({ kind: "connected", sinceMs: NOW + 60_000, lastHeartbeatAtMs: NOW + 60_000 }),
      { now: NOW },
    );
    expect(r.tooltip).toContain("**Uptime:** 0s");
    expect(r.tooltip).toContain("**Last heartbeat:** 0s ago");
  });

  it("formats hour-scale duration as 'Xh Ym Zs'", () => {
    const r = formatP2PStatusBar(
      snap({
        kind: "connected",
        sinceMs: NOW - (1 * 3600 + 2 * 60 + 3) * 1000,
        lastHeartbeatAtMs: NOW,
      }),
      { now: NOW },
    );
    expect(r.tooltip).toContain("1h 2m 3s");
  });
});
