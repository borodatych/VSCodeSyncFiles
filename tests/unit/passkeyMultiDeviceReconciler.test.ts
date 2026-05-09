/**
 * v2.20.4 — multi-device passkey reconciler tests.
 */
import { describe, expect, it } from "vitest";
import { reconcilePasskeyRegistries, PasskeyImportNotImplementedError } from "../../src/core/passkeyMultiDeviceReconciler.js";
import type { PasskeyCredentialRegistry } from "../../src/core/passkeyCredentialRegistry.js";

function reg(...entries: PasskeyCredentialRegistry["entries"]): PasskeyCredentialRegistry {
  return { version: 1, entries };
}

describe("reconcilePasskeyRegistries", () => {
  it("imports remote-only credentials, preserving order", () => {
    const local = reg({ id: "a", displayName: "A", userAgent: "ua", enrolledAtMs: 1, lastUsedAtMs: null });
    const remote = reg({ id: "b", displayName: "B", userAgent: "ua", enrolledAtMs: 2, lastUsedAtMs: null });
    const r = reconcilePasskeyRegistries(local, remote);
    expect(r.merged.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(r.addedIds).toEqual(["b"]);
    expect(r.updatedIds).toEqual([]);
  });

  it("keeps local displayName for shared credential", () => {
    const local = reg({ id: "x", displayName: "Local label", userAgent: "ua", enrolledAtMs: 1, lastUsedAtMs: 100 });
    const remote = reg({ id: "x", displayName: "Remote label", userAgent: "ua", enrolledAtMs: 1, lastUsedAtMs: 200 });
    const r = reconcilePasskeyRegistries(local, remote);
    expect(r.merged.entries[0]?.displayName).toBe("Local label");
    expect(r.merged.entries[0]?.lastUsedAtMs).toBe(200);
    expect(r.updatedIds).toEqual(["x"]);
    expect(r.addedIds).toEqual([]);
  });

  it("preserves local primaryId when set on both sides", () => {
    const local: PasskeyCredentialRegistry = {
      version: 1,
      entries: [{ id: "x", displayName: "X", userAgent: "ua", enrolledAtMs: 1, lastUsedAtMs: null }],
      primaryId: "x",
    };
    const remote: PasskeyCredentialRegistry = {
      version: 1,
      entries: [{ id: "y", displayName: "Y", userAgent: "ua", enrolledAtMs: 2, lastUsedAtMs: null }],
      primaryId: "y",
    };
    const r = reconcilePasskeyRegistries(local, remote);
    expect(r.merged.primaryId).toBe("x");
  });

  it("falls back to remote primaryId when local was absent", () => {
    const local: PasskeyCredentialRegistry = { version: 1, entries: [] };
    const remote: PasskeyCredentialRegistry = {
      version: 1,
      entries: [{ id: "y", displayName: "Y", userAgent: "ua", enrolledAtMs: 1, lastUsedAtMs: null }],
      primaryId: "y",
    };
    const r = reconcilePasskeyRegistries(local, remote);
    expect(r.merged.primaryId).toBe("y");
  });

  it("never returns a primaryId that is no longer in the merged set", () => {
    const local: PasskeyCredentialRegistry = {
      version: 1,
      entries: [{ id: "x", displayName: "X", userAgent: "ua", enrolledAtMs: 1, lastUsedAtMs: null }],
      primaryId: "ghost",
    };
    const r = reconcilePasskeyRegistries(local, reg());
    expect(r.merged.primaryId).toBeUndefined();
  });
});

describe("PasskeyImportNotImplementedError", () => {
  it("has the documented code", () => {
    const e = new PasskeyImportNotImplementedError();
    expect(e.code).toBe("passkey_import_not_wired");
  });
});
