/**
 * Optional provider methods must survive every wrapper in the chain.
 *
 * Precedent: `wrapWithQueue` silently dropped `moveFile`, which demoted every
 * canonical rename to a full download+upload with nothing to notice it by.
 * The quota wrapper had the same hole before it was ever composed in. This
 * pins both wrappers, alone and stacked as the engine factory stacks them.
 */
import { describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { wrapWithQueue } from "../../src/core/queuedProvider.js";
import { wrapWithQuotaTracking } from "../../src/core/quotaProviderWrapper.js";
import { createQuotaTracker } from "../../src/core/quotaTracker.js";

function chain(): { provider: ReturnType<typeof wrapWithQuotaTracking>; tracker: ReturnType<typeof createQuotaTracker> } {
  const tracker = createQuotaTracker();
  // Exactly the composition in _engineFactory.ts.
  const provider = wrapWithQuotaTracking(wrapWithQueue(new MockCloudProvider("onedrive")), tracker);
  return { provider, tracker };
}

describe("проброс опциональных методов сквозь обёртки", () => {
  it("moveFile переживает обе обёртки и реально переносит файл", async () => {
    const { provider } = chain();
    await provider.uploadFile("VSCodeSyncFiles/ws/a.ts", Buffer.from("x"));
    expect(typeof provider.moveFile).toBe("function");
    await provider.moveFile!("VSCodeSyncFiles/ws/a.ts", "VSCodeSyncFiles/ws/b.ts");
    const moved = await provider.downloadFile("VSCodeSyncFiles/ws/b.ts");
    expect(moved.body.toString()).toBe("x");
  });

  it("quota-обёртка одна тоже не теряет moveFile", async () => {
    const tracker = createQuotaTracker();
    const provider = wrapWithQuotaTracking(new MockCloudProvider("gdrive"), tracker);
    await provider.uploadFile("VSCodeSyncFiles/ws/a.ts", Buffer.from("y"));
    expect(typeof provider.moveFile).toBe("function");
    await provider.moveFile!("VSCodeSyncFiles/ws/a.ts", "VSCodeSyncFiles/ws/c.ts");
    await expect(provider.downloadFile("VSCodeSyncFiles/ws/c.ts")).resolves.toBeDefined();
  });

  it("провайдер без moveFile не обрастает нерабочей заглушкой", () => {
    const bare = new MockCloudProvider("dropbox");
    Object.defineProperty(bare, "moveFile", { value: undefined });
    const wrapped = wrapWithQuotaTracking(bare, createQuotaTracker());
    expect(typeof wrapped.moveFile).toBe("undefined");
  });

  it("data-plane вызовы считаются, включая move", async () => {
    const { provider, tracker } = chain();
    await provider.uploadFile("VSCodeSyncFiles/ws/a.ts", Buffer.from("x")); // 1
    await provider.moveFile!("VSCodeSyncFiles/ws/a.ts", "VSCodeSyncFiles/ws/b.ts"); // 2
    await provider.downloadFile("VSCodeSyncFiles/ws/b.ts"); // 3
    expect(tracker.snapshot("onedrive").callsInWindow).toBe(3);
  });

  it("control-plane вызовы квоту не тратят", async () => {
    const { provider, tracker } = chain();
    await provider.isAuthenticated();
    expect(tracker.snapshot("onedrive").callsInWindow).toBe(0);
  });
});
