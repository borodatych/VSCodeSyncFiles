import { describe, expect, it } from "vitest";
import {
  diagnoseManifest,
  formatManifestDiagnostics,
} from "../../src/core/manifestValidationDiagnostics.js";
import type { CloudManifest } from "../../src/core/cloudLayout.js";

function manifest(overrides: Partial<CloudManifest> = {}): CloudManifest {
  return {
    workspaceId: "ws1",
    schemaVersion: 1,
    workspaceNote: "test",
    tags: [],
    providerType: "gdrive",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    files: [
      { path: "a.txt", addedAt: "2026-01-01T00:00:00Z", version: 1, hasSyncignoreMarkers: false },
    ],
    machines: [
      { machineId: "m1", machineName: "host", lastSeen: "2026-01-01T00:00:00Z" },
    ],
    ...overrides,
  };
}

describe("diagnoseManifest — happy path", () => {
  it("returns publishable=true and no diagnostics on a valid manifest", () => {
    const r = diagnoseManifest(manifest());
    expect(r.publishable).toBe(true);
    expect(r.diagnostics).toEqual([]);
  });
});

describe("diagnoseManifest — shape failures", () => {
  it("returns shape_invalid + halts on a malformed input", () => {
    const r = diagnoseManifest({ broken: true });
    expect(r.publishable).toBe(false);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].kind).toBe("shape_invalid");
  });

  it("does not run later checks when shape is invalid", () => {
    const r = diagnoseManifest("totally not an object");
    expect(r.diagnostics.every((d) => d.kind === "shape_invalid")).toBe(true);
  });
});

describe("diagnoseManifest — duplicate file paths", () => {
  it("flags duplicate_file_path as error", () => {
    const r = diagnoseManifest(manifest({
      files: [
        { path: "dup.txt", addedAt: "2026-01-01T00:00:00Z", version: 1, hasSyncignoreMarkers: false },
        { path: "dup.txt", addedAt: "2026-01-02T00:00:00Z", version: 2, hasSyncignoreMarkers: false },
      ],
    }));
    expect(r.publishable).toBe(false);
    expect(r.diagnostics.find((d) => d.kind === "duplicate_file_path")?.ref).toBe("dup.txt");
  });
});

describe("diagnoseManifest — addedAt format", () => {
  it("warns when addedAt is not ISO-8601", () => {
    const r = diagnoseManifest(manifest({
      files: [{ path: "x.txt", addedAt: "yesterday", version: 1, hasSyncignoreMarkers: false }],
    }));
    expect(r.publishable).toBe(true);
    const issue = r.diagnostics.find((d) => d.kind === "addedAt_not_iso");
    expect(issue?.severity).toBe("warning");
    expect(issue?.ref).toBe("x.txt");
  });

  it("accepts millisecond + timezone variants", () => {
    const r = diagnoseManifest(manifest({
      files: [{ path: "x.txt", addedAt: "2026-01-01T00:00:00.123+02:00", version: 1, hasSyncignoreMarkers: false }],
    }));
    expect(r.diagnostics.find((d) => d.kind === "addedAt_not_iso")).toBeUndefined();
  });
});

describe("diagnoseManifest — tag whitespace", () => {
  it("warns on tags with leading/trailing whitespace", () => {
    const r = diagnoseManifest(manifest({ tags: ["clean", "  spacey  "] }));
    expect(r.diagnostics.find((d) => d.kind === "tag_with_whitespace")?.ref).toBe("  spacey  ");
  });

  it("warns on empty string tag", () => {
    const r = diagnoseManifest(manifest({ tags: ["", "ok"] }));
    expect(r.diagnostics.find((d) => d.kind === "tag_with_whitespace")?.ref).toBe("");
  });
});

describe("diagnoseManifest — machine roster consistency", () => {
  it("emits info for files whose editingBy is not in machines[]", () => {
    const r = diagnoseManifest(manifest({
      files: [
        { path: "x.txt", addedAt: "2026-01-01T00:00:00Z", version: 1, hasSyncignoreMarkers: false, editingBy: "ghost" },
      ],
    }));
    expect(r.publishable).toBe(true);
    const issue = r.diagnostics.find((d) => d.kind === "machine_not_in_machines_array");
    expect(issue?.severity).toBe("info");
  });
});

describe("formatManifestDiagnostics", () => {
  it("renders 'Manifest OK' for empty report", () => {
    const r = diagnoseManifest(manifest());
    expect(formatManifestDiagnostics(r)).toBe("Manifest OK — no diagnostics.");
  });

  it("renders header with counts and one line per diagnostic", () => {
    const r = diagnoseManifest(manifest({
      files: [
        { path: "a", addedAt: "yesterday", version: 1, hasSyncignoreMarkers: false },
        { path: "a", addedAt: "today", version: 2, hasSyncignoreMarkers: false },
      ],
    }));
    const text = formatManifestDiagnostics(r);
    expect(text).toContain("errors");
    expect(text).toContain("warnings");
    expect(text).toContain("ERROR");
    expect(text).toContain("WARNING");
  });
});
