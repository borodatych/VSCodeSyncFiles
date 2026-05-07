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
