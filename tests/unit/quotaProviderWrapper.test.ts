import { describe, expect, it, vi } from "vitest";
import { wrapWithQuotaTracking } from "../../src/core/quotaProviderWrapper.js";
import { createQuotaTracker } from "../../src/core/quotaTracker.js";
import type {
  DownloadResult,
  FileMetadata,
  ICloudProvider,
  UploadResult,
} from "../../src/providers/cloudProviderTypes.js";

function makeFakeProvider(): ICloudProvider {
  return {
    type: "gdrive",
    isAuthenticated: vi.fn().mockResolvedValue(true),
    authenticate: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue({ etag: "e1" } satisfies UploadResult),
    downloadFile: vi.fn().mockResolvedValue({ body: Buffer.from("x") } satisfies DownloadResult),
    getMetadata: vi.fn().mockResolvedValue({ cloudPath: "/" } satisfies FileMetadata),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    listFolder: vi.fn().mockResolvedValue([]),
    createFolder: vi.fn().mockResolvedValue(undefined),
  };
}

describe("wrapWithQuotaTracking — data-plane recording", () => {
  it("increments tracker on uploadFile", async () => {
    const tracker = createQuotaTracker();
    const provider = makeFakeProvider();
    const wrapped = wrapWithQuotaTracking(provider, tracker);
    await wrapped.uploadFile("/x", Buffer.from("x"));
    expect(tracker.snapshot("gdrive").callsInWindow).toBe(1);
  });

  it("increments tracker on downloadFile", async () => {
    const tracker = createQuotaTracker();
    const provider = makeFakeProvider();
    const wrapped = wrapWithQuotaTracking(provider, tracker);
    await wrapped.downloadFile("/x");
    expect(tracker.snapshot("gdrive").callsInWindow).toBe(1);
  });

  it("increments tracker on getMetadata, deleteFile, listFolder, createFolder", async () => {
    const tracker = createQuotaTracker();
    const provider = makeFakeProvider();
    const wrapped = wrapWithQuotaTracking(provider, tracker);
    await wrapped.getMetadata("/x");
    await wrapped.deleteFile("/x");
    await wrapped.listFolder("/x");
    await wrapped.createFolder("/x");
    expect(tracker.snapshot("gdrive").callsInWindow).toBe(4);
  });

  it("aggregates calls from mixed methods into one rolling-window count", async () => {
    const tracker = createQuotaTracker();
    const provider = makeFakeProvider();
    const wrapped = wrapWithQuotaTracking(provider, tracker);
    await Promise.all([
      wrapped.uploadFile("/a", Buffer.alloc(0)),
      wrapped.downloadFile("/b"),
      wrapped.getMetadata("/c"),
    ]);
    expect(tracker.snapshot("gdrive").callsInWindow).toBe(3);
  });
});

describe("wrapWithQuotaTracking — control-plane bypass", () => {
  it("does NOT increment tracker on isAuthenticated / authenticate / logout", async () => {
    const tracker = createQuotaTracker();
    const provider = makeFakeProvider();
    const wrapped = wrapWithQuotaTracking(provider, tracker);
    await wrapped.isAuthenticated();
    await wrapped.authenticate();
    await wrapped.logout();
    expect(tracker.snapshot("gdrive").callsInWindow).toBe(0);
  });
});

describe("wrapWithQuotaTracking — delegates results unchanged", () => {
  it("returns the inner provider's upload result verbatim", async () => {
    const tracker = createQuotaTracker();
    const provider = makeFakeProvider();
    const wrapped = wrapWithQuotaTracking(provider, tracker);
    const r = await wrapped.uploadFile("/x", Buffer.from("x"));
    expect(r.etag).toBe("e1");
  });

  it("preserves provider.type", () => {
    const tracker = createQuotaTracker();
    const provider = makeFakeProvider();
    const wrapped = wrapWithQuotaTracking(provider, tracker);
    expect(wrapped.type).toBe("gdrive");
  });

  it("propagates exceptions from inner provider without recording extra calls", async () => {
    const tracker = createQuotaTracker();
    const provider = makeFakeProvider();
    (provider.uploadFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const wrapped = wrapWithQuotaTracking(provider, tracker);
    await expect(wrapped.uploadFile("/x", Buffer.from("x"))).rejects.toThrow("boom");
    // Recorded once before the rejection — that's the API call attempt.
    expect(tracker.snapshot("gdrive").callsInWindow).toBe(1);
  });
});

describe("wrapWithQuotaTracking — composability with queue wrapper", () => {
  it("does not interfere when wrapped twice (idempotent counting per call)", async () => {
    const tracker = createQuotaTracker();
    const provider = makeFakeProvider();
    const onceWrapped = wrapWithQuotaTracking(provider, tracker);
    const twiceWrapped = wrapWithQuotaTracking(onceWrapped, tracker);
    await twiceWrapped.uploadFile("/x", Buffer.alloc(0));
    // Two layers → two records. Caller is responsible for not double-wrapping;
    // the assertion documents the contract.
    expect(tracker.snapshot("gdrive").callsInWindow).toBe(2);
  });
});
