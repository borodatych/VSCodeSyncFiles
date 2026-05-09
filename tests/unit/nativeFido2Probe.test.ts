/**
 * v2.2.2 — native FIDO2 probe tests.
 */
import { describe, expect, it } from "vitest";
import { probeNativeFido2 } from "../../src/core/nativeFido2Probe.js";

describe("probeNativeFido2", () => {
  it("returns module_not_installed when no candidates are configured", () => {
    const r = probeNativeFido2({ candidates: [] });
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toBe("module_not_installed");
  });

  it("returns module_not_installed when each candidate throws cannot-find-module", () => {
    const r = probeNativeFido2({
      candidates: ["fake-binding-a", "fake-binding-b"],
      loader: (name) => {
        throw new Error(`Cannot find module '${name}'`);
      },
    });
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toBe("module_not_installed");
  });

  it("returns module_load_failed when the candidate throws something else", () => {
    const r = probeNativeFido2({
      candidates: ["broken-binding"],
      loader: () => {
        throw new Error("postinstall failed: missing libfido2.so");
      },
    });
    expect(r.available).toBe(false);
    if (!r.available) {
      expect(r.reason).toBe("module_load_failed");
      expect(r.error).toContain("libfido2.so");
    }
  });

  it("returns adapter+backendName on first successful candidate", () => {
    const r = probeNativeFido2({
      candidates: ["fido2-lib"],
      loader: (name) => ({ name, Authenticator: function () { /* skeleton */ } }),
    });
    expect(r.available).toBe(true);
    if (r.available) {
      expect(r.backendName).toBe("fido2-lib");
      expect(r.adapter.platform).toBe("native");
      expect(r.adapter.available).toBe(false); // skeleton — real wiring still blocked
    }
  });

  it("walks candidates in priority order", () => {
    const tried: string[] = [];
    probeNativeFido2({
      candidates: ["primary", "fallback"],
      loader: (name) => {
        tried.push(name);
        throw new Error(`Cannot find module '${name}'`);
      },
    });
    expect(tried).toEqual(["primary", "fallback"]);
  });
});
