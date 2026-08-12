/**
 * Local-cache projections of a cloud manifest. The high-water mark is the
 * load-bearing part: `rebuildManifestFromLocalState` numbers rebuilt rows above
 * it, so a rebuild after cloud loss cannot lose 412-merges to stale copies.
 */
import { describe, expect, it } from "vitest";
import type { CloudManifest, ManifestFile } from "../../src/core/cloudLayout.js";
import { entryPatchFromManifest } from "../../src/core/manifestCacheFields.js";

const row = (over: Partial<ManifestFile>): ManifestFile => ({
  path: "a.ts",
  addedAt: "t0",
  version: 1,
  hasSyncignoreMarkers: false,
  ...over,
});

const manifest = (files: ManifestFile[]): CloudManifest => ({
  schemaVersion: 1,
  workspaceId: "ws1",
  workspaceNote: "",
  tags: ["x"],
  providerType: "onedrive",
  createdAt: "t0",
  updatedAt: "t0",
  machines: [],
  files,
});

describe("entryPatchFromManifest — manifestVersionHighWater", () => {
  it("максимум version по всем строкам, tombstone включительно", () => {
    const patch = entryPatchFromManifest(
      manifest([
        row({ path: "a.ts", version: 3 }),
        row({ path: "b.ts", version: 17, removedAt: "t1" }),
        row({ path: "c.ts", version: 5 }),
      ]),
    );
    expect(patch.manifestVersionHighWater).toBe(17);
  });

  it("пустой манифест — 0", () => {
    expect(entryPatchFromManifest(manifest([])).manifestVersionHighWater).toBe(0);
  });
});
