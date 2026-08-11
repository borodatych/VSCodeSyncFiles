/**
 * Tests for `validateManifestShape` — the pre-flight check `putManifest` runs
 * before pushing a manifest to the cloud. The validator deliberately rejects
 * shapes that downstream code (or other machines) would crash on.
 */
import { describe, it, expect } from "vitest";
import { validateManifestShape } from "../../src/core/manifestValidate.js";

const goodManifest = {
  schemaVersion: 1,
  workspaceId: "ws-uuid",
  workspaceNote: "demo",
  providerType: "onedrive",
  createdAt: "2026-05-07T10:00:00.000Z",
  updatedAt: "2026-05-07T11:00:00.000Z",
  files: [
    { path: "src/a.ts", addedAt: "2026-05-07T10:00:00.000Z", version: 1 },
  ],
  machines: [
    { machineId: "M1", machineName: "macbook", lastSeen: "2026-05-07T10:00:00.000Z" },
  ],
  tags: ["frontend", "auth"],
};

describe("validateManifestShape", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifestShape(goodManifest)).toEqual({ ok: true });
  });

  it("rejects null / non-object", () => {
    expect(validateManifestShape(null).ok).toBe(false);
    expect(validateManifestShape("string").ok).toBe(false);
    expect(validateManifestShape(42).ok).toBe(false);
  });

  it("rejects empty workspaceId", () => {
    expect(validateManifestShape({ ...goodManifest, workspaceId: "" }).ok).toBe(false);
  });

  it("rejects non-numeric schemaVersion", () => {
    expect(validateManifestShape({ ...goodManifest, schemaVersion: "1" }).ok).toBe(false);
  });

  it("rejects missing files array", () => {
    expect(validateManifestShape({ ...goodManifest, files: undefined }).ok).toBe(false);
    expect(validateManifestShape({ ...goodManifest, files: "string" }).ok).toBe(false);
  });

  it("rejects file with empty path", () => {
    expect(
      validateManifestShape({
        ...goodManifest,
        files: [{ path: "", addedAt: "2026-05-07T10:00:00.000Z", version: 1 }],
      }).ok,
    ).toBe(false);
  });

  it("rejects file path containing backslash (must be POSIX)", () => {
    expect(
      validateManifestShape({
        ...goodManifest,
        files: [{ path: "src\\a.ts", addedAt: "2026-05-07T10:00:00.000Z", version: 1 }],
      }).ok,
    ).toBe(false);
  });

  it("rejects file with non-finite version", () => {
    expect(
      validateManifestShape({
        ...goodManifest,
        files: [{ path: "a.ts", addedAt: "2026-05-07T10:00:00.000Z", version: NaN }],
      }).ok,
    ).toBe(false);
    expect(
      validateManifestShape({
        ...goodManifest,
        files: [{ path: "a.ts", addedAt: "2026-05-07T10:00:00.000Z", version: Infinity }],
      }).ok,
    ).toBe(false);
  });

  it("rejects machine without all required string fields", () => {
    expect(
      validateManifestShape({
        ...goodManifest,
        machines: [{ machineId: "M1", machineName: "macbook" /* lastSeen missing */ }],
      }).ok,
    ).toBe(false);
  });

  it("rejects tags that aren't a string array", () => {
    expect(
      validateManifestShape({ ...goodManifest, tags: ["ok", 123] }).ok,
    ).toBe(false);
  });

  it("accepts manifest without optional tags field", () => {
    const m = { ...goodManifest };
    delete (m as { tags?: unknown }).tags;
    expect(validateManifestShape(m)).toEqual({ ok: true });
  });

  it("error reason is human-readable", () => {
    const r = validateManifestShape({ ...goodManifest, workspaceId: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/workspaceId/);
    }
  });
});

describe("validateManifestShape — link bindings (docs/v2/linkBindings.md)", () => {
  const withFile = (file: object) =>
    validateManifestShape({ ...goodManifest, files: [{ ...goodManifest.files[0], ...file }] });

  it("accepts linkId/linkName/bindings in valid shape", () => {
    expect(
      withFile({
        linkId: "aabbccddeeff0011",
        linkName: "метка",
        bindings: { M1: { path: "custom/place.ts", boundAt: "2026-08-11T10:00:00.000Z" } },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects empty linkId and non-string linkName", () => {
    expect(withFile({ linkId: "" }).ok).toBe(false);
    expect(withFile({ linkName: 42 }).ok).toBe(false);
  });

  it("rejects bindings that are not an object of entries", () => {
    expect(withFile({ bindings: "M1" }).ok).toBe(false);
    expect(withFile({ bindings: ["M1"] }).ok).toBe(false);
    expect(withFile({ bindings: { M1: "custom/place.ts" } }).ok).toBe(false);
  });

  it("rejects unsafe binding paths: absolute, backslash, dot-dot, missing boundAt", () => {
    const bad = (path: string) => withFile({ bindings: { M1: { path, boundAt: "t" } } }).ok;
    expect(bad("/etc/passwd")).toBe(false);
    expect(bad("a\\b.ts")).toBe(false);
    expect(bad("../escape.ts")).toBe(false);
    expect(bad("ok/../../escape.ts")).toBe(false);
    expect(bad("")).toBe(false);
    expect(withFile({ bindings: { M1: { path: "ok.ts" } } }).ok).toBe(false);
  });
});
