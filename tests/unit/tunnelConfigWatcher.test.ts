import { describe, expect, it } from "vitest";
import {
  compareTunnelConfig,
  type TunnelConfigSnapshot,
} from "../../src/core/tunnelConfigWatcher.js";

const snap = (over: Partial<TunnelConfigSnapshot> = {}): TunnelConfigSnapshot => ({
  rawProvider: "smee",
  resolved: "smee",
  enabled: true,
  url: undefined,
  ...over,
});

describe("compareTunnelConfig", () => {
  it("first activation when prev is null and tunnel enabled", () => {
    const r = compareTunnelConfig(null, snap({ enabled: true }));
    expect(r.action).toBe("start");
  });

  it("first activation skipped if prev null and tunnel disabled", () => {
    const r = compareTunnelConfig(null, snap({ enabled: false }));
    expect(r.action).toBe("no_change");
  });

  it("stop when transitioning enabled → disabled", () => {
    const r = compareTunnelConfig(snap({ enabled: true }), snap({ enabled: false }));
    expect(r.action).toBe("stop");
  });

  it("start when transitioning disabled → enabled", () => {
    const r = compareTunnelConfig(snap({ enabled: false }), snap({ enabled: true }));
    expect(r.action).toBe("start");
  });

  it("restart on provider change", () => {
    const r = compareTunnelConfig(snap({ resolved: "smee" }), snap({ resolved: "cloudflared" }));
    expect(r.action).toBe("restart");
    if (r.action === "restart") expect(r.reason).toContain("provider_changed");
  });

  it("restart on URL change", () => {
    const r = compareTunnelConfig(snap({ url: "" }), snap({ url: "https://x.example" }));
    expect(r.action).toBe("restart");
    if (r.action === "restart") expect(r.reason).toBe("url_changed");
  });

  it("no_change on irrelevant differences", () => {
    expect(compareTunnelConfig(snap(), snap()).action).toBe("no_change");
  });

  it("no_change when tunnel was already disabled", () => {
    const r = compareTunnelConfig(
      snap({ enabled: false, resolved: "smee" }),
      snap({ enabled: false, resolved: "cloudflared" }),
    );
    expect(r.action).toBe("no_change");
  });
});
