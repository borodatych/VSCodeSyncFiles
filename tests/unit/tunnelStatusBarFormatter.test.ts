import { describe, expect, it } from "vitest";
import { formatTunnelStatusBar } from "../../src/core/tunnelStatusBarFormatter.js";
import type { TunnelStatusSnapshot } from "../../src/core/tunnelStatusRegistry.js";

const NOW = 1_700_000_000_000;

function snap(overrides: Partial<TunnelStatusSnapshot> = {}): TunnelStatusSnapshot {
  return {
    effectiveProvider: "smee",
    requestedProvider: "smee",
    publicUrl: "https://smee.io/abc",
    restartCount: 0,
    startedAtMs: NOW - 65 * 1000,
    ...overrides,
  };
}

describe("formatTunnelStatusBar — inactive", () => {
  it("returns an off-state widget when snapshot is undefined", () => {
    const r = formatTunnelStatusBar(undefined);
    expect(r.text).toBe("$(plug) Tunnel: off");
    expect(r.severity).toBe("ok");
    expect(r.commandId).toBe("vscodesync.showTunnelStatus");
  });

  it("respects a caller-supplied commandId override", () => {
    const r = formatTunnelStatusBar(undefined, { commandId: "vscodesync.foo" });
    expect(r.commandId).toBe("vscodesync.foo");
  });
});

describe("formatTunnelStatusBar — happy path", () => {
  it("uses $(plug) icon when active and no fallback occurred", () => {
    const r = formatTunnelStatusBar(snap(), { now: NOW });
    expect(r.text).toBe("$(plug) Tunnel: smee");
    expect(r.severity).toBe("ok");
  });

  it("includes uptime + URL + restart count in tooltip markdown", () => {
    const r = formatTunnelStatusBar(snap(), { now: NOW });
    expect(r.tooltip).toContain("Public URL");
    expect(r.tooltip).toContain("smee.io/abc");
    expect(r.tooltip).toContain("Uptime");
    expect(r.tooltip).toContain("1m 5s");
    expect(r.tooltip).toContain("Restarts");
  });
});

describe("formatTunnelStatusBar — fallback severity", () => {
  it("escalates to warn when requested != effective", () => {
    const r = formatTunnelStatusBar(
      snap({ requestedProvider: "cloudflared", effectiveProvider: "smee" }),
      { now: NOW },
    );
    expect(r.severity).toBe("warn");
    expect(r.text).toBe("$(warning) Tunnel: smee");
  });

  it("escalates to warn when lastFallbackReason is present even on requested=effective", () => {
    const r = formatTunnelStatusBar(snap({ lastFallbackReason: "spawn_failed: ENOENT" }));
    expect(r.severity).toBe("warn");
  });

  it("escalates to error when restartCount >= 3", () => {
    const r = formatTunnelStatusBar(snap({ restartCount: 3 }));
    expect(r.severity).toBe("error");
    expect(r.text).toBe("$(error) Tunnel: smee");
  });
});

describe("formatTunnelStatusBar — uptime formatting", () => {
  it("formats sub-minute uptime in seconds", () => {
    const r = formatTunnelStatusBar(snap({ startedAtMs: NOW - 30 * 1000 }), { now: NOW });
    expect(r.tooltip).toContain("30s");
    expect(r.tooltip).not.toContain("1m");
  });

  it("formats hour-scale uptime as 'Xh Ym Zs'", () => {
    const r = formatTunnelStatusBar(
      snap({ startedAtMs: NOW - (2 * 3600 + 5 * 60 + 7) * 1000 }),
      { now: NOW },
    );
    expect(r.tooltip).toContain("2h 5m 7s");
  });

  it("clamps negative uptime to 0s when startedAtMs is in the future", () => {
    const r = formatTunnelStatusBar(snap({ startedAtMs: NOW + 60_000 }), { now: NOW });
    expect(r.tooltip).toContain("**Uptime:** 0s");
  });
});

describe("formatTunnelStatusBar — fallback reason rendering", () => {
  it("includes lastFallbackReason in tooltip when set", () => {
    const r = formatTunnelStatusBar(snap({ lastFallbackReason: "bind_failed: EADDRINUSE" }));
    expect(r.tooltip).toContain("Last fallback");
    expect(r.tooltip).toContain("EADDRINUSE");
  });

  it("omits 'Last fallback' line entirely when reason is undefined", () => {
    const r = formatTunnelStatusBar(snap());
    expect(r.tooltip).not.toContain("Last fallback");
  });
});
