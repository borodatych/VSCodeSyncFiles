import { describe, expect, it } from "vitest";
import {
  TASK_REGISTRY,
  lookupTaskMetadata,
} from "../../src/core/vscodeTaskDefinitions.js";

describe("TASK_REGISTRY", () => {
  it("registers expected kinds", () => {
    const kinds = TASK_REGISTRY.map((t) => t.kind).sort();
    expect(kinds).toContain("push");
    expect(kinds).toContain("pull");
    expect(kinds).toContain("snapshot");
    expect(kinds).toContain("repair-manifest");
    expect(kinds).toContain("support-bundle");
  });
  it("every entry has a commandId starting with vscodesync.", () => {
    for (const t of TASK_REGISTRY) {
      expect(t.commandId.startsWith("vscodesync.")).toBe(true);
    }
  });
  it("kinds are unique", () => {
    const kinds = TASK_REGISTRY.map((t) => t.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe("lookupTaskMetadata", () => {
  it("returns metadata for known kind", () => {
    const m = lookupTaskMetadata("push");
    expect(m?.label).toBe("VSCodeSync: Push");
  });
  it("returns null for unknown kind", () => {
    expect(lookupTaskMetadata("not-a-kind")).toBeNull();
  });
});
