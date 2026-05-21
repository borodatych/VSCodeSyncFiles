import { describe, expect, it } from "vitest";
import { groupTrackedFilesForScm } from "../../src/core/scmResourceGrouper.js";
import type { TrackedFile } from "../../src/core/types.js";

const tf = (overrides: Partial<TrackedFile>): TrackedFile => ({
  localPath: "a.ts",
  workspaceId: "w1",
  cloudPath: "cloud/a.ts",
  lastSync: "2026-05-21T00:00:00Z",
  localHash: "h",
  syncStatus: "ok",
  ...overrides,
});

describe("groupTrackedFilesForScm", () => {
  it("empty input → empty groups", () => {
    expect(groupTrackedFilesForScm([])).toEqual([]);
  });

  it("bucketises by sync status", () => {
    const out = groupTrackedFilesForScm([
      tf({ syncStatus: "conflict", localPath: "c.ts" }),
      tf({ syncStatus: "pending_push", localPath: "p.ts" }),
      tf({ syncStatus: "cloud_newer", localPath: "n.ts" }),
      tf({ syncStatus: "ok", localPath: "o.ts" }),
    ]);
    expect(out.map((g) => g.id)).toEqual(["conflict", "pending_push", "cloud_newer"]);
  });

  it("soft-lock (editingBy) wins over status", () => {
    const out = groupTrackedFilesForScm([
      tf({ syncStatus: "pending_push", editingBy: "other", localPath: "x.ts" }),
    ]);
    expect(out[0]?.id).toBe("soft_locked");
  });

  it("severity assigned per group", () => {
    const out = groupTrackedFilesForScm([
      tf({ syncStatus: "conflict" }),
      tf({ syncStatus: "pending_push" }),
      tf({ syncStatus: "cloud_newer" }),
    ]);
    expect(out.find((g) => g.id === "conflict")?.severity).toBe("error");
    expect(out.find((g) => g.id === "pending_push")?.severity).toBe("warn");
    expect(out.find((g) => g.id === "cloud_newer")?.severity).toBe("info");
  });

  it("ok_recent surfaces N newest synced files", () => {
    const out = groupTrackedFilesForScm(
      [
        tf({ syncStatus: "ok", lastSync: "2026-01-01T00:00:00Z", localPath: "old.ts" }),
        tf({ syncStatus: "ok", lastSync: "2026-05-21T00:00:00Z", localPath: "new.ts" }),
        tf({ syncStatus: "ok", lastSync: "2026-03-01T00:00:00Z", localPath: "mid.ts" }),
      ],
      { okRecentCount: 2 },
    );
    const recent = out.find((g) => g.id === "ok_recent");
    expect(recent?.files.map((f) => f.localPath)).toEqual(["new.ts", "mid.ts"]);
  });

  it("ok_recent omitted when count is 0", () => {
    const out = groupTrackedFilesForScm([tf({ syncStatus: "ok" })], { okRecentCount: 0 });
    expect(out.find((g) => g.id === "ok_recent")).toBeUndefined();
  });
});
