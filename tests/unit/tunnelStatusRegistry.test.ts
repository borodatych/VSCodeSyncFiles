import { afterEach, describe, expect, it } from "vitest";
import {
  bumpTunnelRestartCount,
  clearTunnelStatus,
  formatTunnelStatusReport,
  getTunnelStatus,
  noteTunnelFallback,
  setTunnelStatus,
} from "../../src/core/tunnelStatusRegistry.js";

afterEach(() => {
  clearTunnelStatus();
});

describe("tunnelStatusRegistry — set / get / clear", () => {
  it("returns undefined before any setTunnelStatus call", () => {
    expect(getTunnelStatus()).toBeUndefined();
  });

  it("setTunnelStatus persists the snapshot", () => {
    setTunnelStatus({
      effectiveProvider: "cloudflared",
      requestedProvider: "cloudflared",
      publicUrl: "https://abc.example.com",
      restartCount: 0,
      startedAtMs: 1_700_000_000_000,
    });
    expect(getTunnelStatus()?.publicUrl).toBe("https://abc.example.com");
  });

  it("clearTunnelStatus resets to undefined", () => {
    setTunnelStatus({
      effectiveProvider: "smee",
      requestedProvider: "smee",
      publicUrl: "https://smee.io/x",
      restartCount: 0,
      startedAtMs: 0,
    });
    clearTunnelStatus();
    expect(getTunnelStatus()).toBeUndefined();
  });
});

describe("tunnelStatusRegistry — bumpTunnelRestartCount + noteTunnelFallback", () => {
  it("bumpTunnelRestartCount increments the counter idempotently", () => {
    setTunnelStatus({
      effectiveProvider: "smee",
      requestedProvider: "smee",
      publicUrl: "https://smee.io/x",
      restartCount: 0,
      startedAtMs: 0,
    });
    bumpTunnelRestartCount();
    bumpTunnelRestartCount();
    expect(getTunnelStatus()?.restartCount).toBe(2);
  });

  it("noteTunnelFallback records the reason on the snapshot", () => {
    setTunnelStatus({
      effectiveProvider: "smee",
      requestedProvider: "cloudflared",
      publicUrl: "https://smee.io/x",
      restartCount: 0,
      startedAtMs: 0,
    });
    noteTunnelFallback("backend_cloudflared_unavailable");
    expect(getTunnelStatus()?.lastFallbackReason).toBe("backend_cloudflared_unavailable");
  });

  it("bump and noteFallback are no-ops when no snapshot is set", () => {
    bumpTunnelRestartCount();
    noteTunnelFallback("x");
    expect(getTunnelStatus()).toBeUndefined();
  });
});

describe("formatTunnelStatusReport", () => {
  it("renders 'not active' when no snapshot", () => {
    expect(formatTunnelStatusReport(undefined)).toBe("Tunnel: not active");
  });

  it("renders effective + requested + uptime + restarts", () => {
    const out = formatTunnelStatusReport(
      {
        effectiveProvider: "smee",
        requestedProvider: "cloudflared",
        publicUrl: "https://smee.io/abc",
        restartCount: 2,
        startedAtMs: 1_000_000,
        lastFallbackReason: "backend_cloudflared_unavailable",
      },
      1_000_000 + 65 * 1000,
    );
    expect(out).toContain("Tunnel: smee");
    expect(out).toContain("Public URL: https://smee.io/abc");
    expect(out).toContain("Requested provider: cloudflared");
    expect(out).toContain("Uptime: 1m 5s");
    expect(out).toContain("Restarts: 2");
    expect(out).toContain("Last fallback: backend_cloudflared_unavailable");
  });

  it("formats hours-uptime correctly", () => {
    const out = formatTunnelStatusReport(
      {
        effectiveProvider: "smee",
        requestedProvider: "smee",
        publicUrl: "u",
        restartCount: 0,
        startedAtMs: 0,
      },
      3 * 3600 * 1000 + 7 * 60 * 1000 + 4 * 1000,
    );
    expect(out).toContain("Uptime: 3h 7m 4s");
  });
});
