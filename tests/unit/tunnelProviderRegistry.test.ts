/**
 * Tests for the tunnel-provider registry/dispatch layer. The cloudflared
 * backend is a skeleton — only the registry contract is exercised here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  listTunnelBackends,
  openTunnel,
  registerTunnelBackend,
  resolveTunnelType,
  type TunnelBackend,
  type TunnelOpenResult,
} from "../../src/ui/tunnelProviderRegistry.js";

describe("resolveTunnelType", () => {
  it("maps known values through unchanged", () => {
    expect(resolveTunnelType("smee")).toBe("smee");
    expect(resolveTunnelType("cloudflared")).toBe("cloudflared");
    expect(resolveTunnelType("tailscale-funnel")).toBe("tailscale-funnel");
  });

  it("falls back to smee for unknown / empty input", () => {
    expect(resolveTunnelType(undefined)).toBe("smee");
    expect(resolveTunnelType("")).toBe("smee");
    expect(resolveTunnelType("ngrok")).toBe("smee");
  });
});

describe("openTunnel dispatch", () => {
  it("returns not_available for an unregistered backend type", async () => {
    const r = await openTunnel("tailscale-funnel", 8080);
    // tailscale-funnel is intentionally not registered; never throws.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_available");
  });

  it("delegates to the registered backend", async () => {
    let opened: number | undefined;
    const stub: TunnelBackend = {
      type: "smee",
      open(port): Promise<TunnelOpenResult> {
        opened = port;
        return Promise.resolve({
          ok: true,
          channel: {
            publicUrl: `https://stub.local/${String(port)}`,
            provider: "smee",
            dispose: () => Promise.resolve(),
          },
        });
      },
    };
    registerTunnelBackend(stub);
    const r = await openTunnel("smee", 1234);
    expect(opened).toBe(1234);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.channel.publicUrl).toBe("https://stub.local/1234");
      await r.channel.dispose();
    }
  });
});

describe("listTunnelBackends", () => {
  beforeEach(() => {
    // The registry is module-global — tests above register a smee stub which
    // stays around. We just assert the type guarantee here.
  });

  it("returns the registered backend types as strings", () => {
    const types = listTunnelBackends();
    expect(types.every((t) => typeof t === "string")).toBe(true);
  });
});
