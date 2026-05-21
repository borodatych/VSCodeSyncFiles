import { describe, expect, it, vi } from "vitest";
import { createLazyProviderRegistry } from "../../src/core/lazyProviderLoader.js";
import type { ICloudProvider } from "../../src/providers/cloudProviderTypes.js";

const fakeProvider = (type: "onedrive" | "gdrive" | "yandex" | "dropbox"): ICloudProvider =>
  ({ type, isAuthenticated: () => Promise.resolve(false) } as unknown as ICloudProvider);

describe("createLazyProviderRegistry", () => {
  it("does not invoke loader until resolve()", () => {
    const load = vi.fn().mockResolvedValue(fakeProvider("onedrive"));
    createLazyProviderRegistry([{ type: "onedrive", load }]);
    expect(load).not.toHaveBeenCalled();
  });

  it("memoises after first resolve", async () => {
    const load = vi.fn().mockResolvedValue(fakeProvider("gdrive"));
    const reg = createLazyProviderRegistry([{ type: "gdrive", load }]);
    const p1 = await reg.resolve("gdrive");
    const p2 = await reg.resolve("gdrive");
    expect(p1).toBe(p2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("isLoaded reflects state", async () => {
    const reg = createLazyProviderRegistry([
      { type: "onedrive", load: () => Promise.resolve(fakeProvider("onedrive")) },
    ]);
    expect(reg.isLoaded("onedrive")).toBe(false);
    await reg.resolve("onedrive");
    expect(reg.isLoaded("onedrive")).toBe(true);
  });

  it("reset drops cache → next resolve re-loads", async () => {
    const load = vi.fn().mockResolvedValue(fakeProvider("yandex"));
    const reg = createLazyProviderRegistry([{ type: "yandex", load }]);
    await reg.resolve("yandex");
    reg.reset("yandex");
    expect(reg.isLoaded("yandex")).toBe(false);
    await reg.resolve("yandex");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("resolve unknown type throws", async () => {
    const reg = createLazyProviderRegistry([]);
    await expect(reg.resolve("dropbox")).rejects.toThrow();
  });
});
