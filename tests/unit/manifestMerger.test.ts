import { describe, expect, it } from "vitest";
import { mergeManifestFiles } from "../../src/core/manifestMerger.js";
import type { ManifestFile } from "../../src/core/cloudLayout.js";

describe("mergeManifestFiles", () => {
  it("больший version побеждает", () => {
    const a: ManifestFile = {
      path: "x",
      addedAt: "t0",
      version: 1,
      hasSyncignoreMarkers: false,
    };
    const b: ManifestFile = {
      path: "x",
      addedAt: "t1",
      version: 3,
      hasSyncignoreMarkers: true,
    };
    const merged = mergeManifestFiles([a], [b]);
    expect(merged[0]?.version).toBe(3);
  });
});
