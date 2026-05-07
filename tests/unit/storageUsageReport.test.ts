import { describe, it, expect } from "vitest";
import {
  buildStorageUsageReport,
  formatBytes,
  workspaceIdFromCloudPath,
} from "../../src/core/storageUsageReport.js";

describe("workspaceIdFromCloudPath", () => {
  it("extracts workspaceId for tracked file", () => {
    expect(workspaceIdFromCloudPath("VSCodeSyncFiles/ws-abc/src/index.ts")).toBe("ws-abc");
  });
  it("ignores global registry", () => {
    expect(workspaceIdFromCloudPath("VSCodeSyncFiles/_machines.json")).toBeUndefined();
  });
  it("ignores quick-transfer", () => {
    expect(workspaceIdFromCloudPath("VSCodeSyncFiles/_quicktransfer/abc/foo.bin")).toBeUndefined();
  });
  it("returns undefined for unrelated paths", () => {
    expect(workspaceIdFromCloudPath("OtherRoot/ws-x/foo.ts")).toBeUndefined();
  });
});

describe("buildStorageUsageReport", () => {
  it("aggregates per workspace and totals", () => {
    const r = buildStorageUsageReport([
      { cloudPath: "VSCodeSyncFiles/A/foo.ts", size: 100 },
      { cloudPath: "VSCodeSyncFiles/A/bar.ts", size: 200 },
      { cloudPath: "VSCodeSyncFiles/B/baz.ts", size: 50 },
      { cloudPath: "VSCodeSyncFiles/_machines.json", size: 5 },
    ]);
    expect(r.totalBytes).toBe(355);
    expect(r.totalFiles).toBe(4);
    expect(r.perWorkspace).toEqual([
      { workspaceId: "A", fileCount: 2, totalBytes: 300 },
      { workspaceId: "B", fileCount: 1, totalBytes: 50 },
    ]);
  });
  it("skips folders (size undefined)", () => {
    const r = buildStorageUsageReport([
      { cloudPath: "VSCodeSyncFiles/A" },
      { cloudPath: "VSCodeSyncFiles/A/foo.ts", size: 100 },
    ]);
    expect(r.totalFiles).toBe(1);
    expect(r.totalBytes).toBe(100);
  });
  it("respects topN", () => {
    const r = buildStorageUsageReport(
      [
        { cloudPath: "VSCodeSyncFiles/A/a.bin", size: 1000 },
        { cloudPath: "VSCodeSyncFiles/A/b.bin", size: 2000 },
        { cloudPath: "VSCodeSyncFiles/A/c.bin", size: 3000 },
      ],
      2,
    );
    expect(r.topFiles).toHaveLength(2);
    expect(r.topFiles[0]?.size).toBe(3000);
    expect(r.topFiles[1]?.size).toBe(2000);
  });
  it("filters negative / NaN sizes", () => {
    const r = buildStorageUsageReport([
      { cloudPath: "VSCodeSyncFiles/A/x", size: -1 },
      { cloudPath: "VSCodeSyncFiles/A/y", size: Number.NaN },
      { cloudPath: "VSCodeSyncFiles/A/z", size: 10 },
    ]);
    expect(r.totalFiles).toBe(1);
    expect(r.totalBytes).toBe(10);
  });
});

describe("formatBytes", () => {
  it("formats bytes / KB / MB / GB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
  it("handles invalid input", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});
