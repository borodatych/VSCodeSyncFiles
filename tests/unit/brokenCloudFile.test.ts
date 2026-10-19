import { describe, it, expect } from "vitest";
import { detectBrokenCloudFile } from "../../src/core/brokenCloudFile.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";
import { manifestCloudPath, metaCloudPath, trackedFileCloudPath } from "../../src/core/cloudLayout.js";

describe("detectBrokenCloudFile", () => {
  it("распознаёт _meta.json", () => {
    const e = new ProviderError("SERVER_ERROR", "x", { cloudPath: metaCloudPath("ws1") });
    expect(detectBrokenCloudFile(e)).toEqual({ kind: "meta", workspaceId: "ws1" });
  });
  it("распознаёт манифест", () => {
    const e = new ProviderError("SERVER_ERROR", "x", { cloudPath: manifestCloudPath("ws1") });
    expect(detectBrokenCloudFile(e)).toEqual({ kind: "manifest", workspaceId: "ws1" });
  });
  it("обычный файл — null", () => {
    const e = new ProviderError("SERVER_ERROR", "x", { cloudPath: trackedFileCloudPath("ws1", "a/b.ts") });
    expect(detectBrokenCloudFile(e)).toBeNull();
  });
  it("NOT_FOUND — null", () => {
    const e = new ProviderError("NOT_FOUND", "x", { cloudPath: metaCloudPath("ws1") });
    expect(detectBrokenCloudFile(e)).toBeNull();
  });
  it("не ProviderError — null", () => {
    expect(detectBrokenCloudFile(new Error("x"))).toBeNull();
    expect(detectBrokenCloudFile(undefined)).toBeNull();
  });
});
