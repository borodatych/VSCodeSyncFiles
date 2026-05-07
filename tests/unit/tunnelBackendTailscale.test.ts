/**
 * Skeleton-level tests for the Tailscale Funnel tunnel backend.
 *
 * The probe (`tailscale --version` via spawn) is intentionally not exercised
 * here — its behaviour depends on the dev machine's PATH, and the skeleton
 * always returns `not_available` regardless. We assert:
 *   - the exported backend has the right `type`
 *   - invalid `localPort` short-circuits to `config_invalid` BEFORE spawning
 *     anything, so the test never blocks on the 3 s probe timeout
 */
import { describe, it, expect } from "vitest";
import { tailscaleFunnelTunnelBackend } from "../../src/ui/tunnelBackendTailscale.js";

describe("tailscaleFunnelTunnelBackend (skeleton)", () => {
  it("declares its type as tailscale-funnel", () => {
    expect(tailscaleFunnelTunnelBackend.type).toBe("tailscale-funnel");
  });

  it("rejects non-positive localPort with config_invalid", async () => {
    const r = await tailscaleFunnelTunnelBackend.open(0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("config_invalid");
      expect(r.detail).toContain("localPort");
    }
  });

  it("rejects NaN localPort with config_invalid", async () => {
    const r = await tailscaleFunnelTunnelBackend.open(Number.NaN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config_invalid");
  });

  it("rejects negative localPort with config_invalid", async () => {
    const r = await tailscaleFunnelTunnelBackend.open(-1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config_invalid");
  });
});
