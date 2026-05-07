import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import type { GlobalConfig } from "../../src/core/types.js";

describe("ProviderRegistry", () => {
  it("возвращает null без активного провайдера", async () => {
    const cfg: GlobalConfig = {
      activeProvider: null,
      machineId: "x",
      machineName: "y",
      onboardingCompleted: true,
      syncPaused: false,
      providers: {},
    };
    const reg = new ProviderRegistry(() => Promise.resolve(cfg));
    reg.register("onedrive", () => new MockCloudProvider("onedrive"));
    await expect(reg.getActive()).resolves.toBeNull();
  });

  it("возвращает зарегистрированный провайдер", async () => {
    const cfg: GlobalConfig = {
      activeProvider: "onedrive",
      machineId: "x",
      machineName: "y",
      onboardingCompleted: true,
      syncPaused: false,
      providers: {},
    };
    const reg = new ProviderRegistry(() => Promise.resolve(cfg));
    reg.register("onedrive", () => new MockCloudProvider("onedrive"));
    const p = await reg.getActive();
    expect(p?.type).toBe("onedrive");
    await expect(p?.isAuthenticated()).resolves.toBe(true);
  });

  it("getFor / isAuthenticatedFor для любого зарегистрированного типа", async () => {
    const cfg: GlobalConfig = {
      activeProvider: "gdrive",
      machineId: "x",
      machineName: "y",
      onboardingCompleted: true,
      syncPaused: false,
      providers: {},
    };
    const reg = new ProviderRegistry(() => Promise.resolve(cfg));
    reg.register("gdrive", () => new MockCloudProvider("gdrive"));
    const p = reg.getFor("gdrive");
    expect(p?.type).toBe("gdrive");
    await expect(reg.isAuthenticatedFor("gdrive")).resolves.toBe(true);
    expect(reg.getFor("onedrive")).toBeNull();
    await expect(reg.isAuthenticatedFor("onedrive")).resolves.toBe(false);
  });

  it("isAuthenticatedFor учитывает false от провайдера", async () => {
    const cfg: GlobalConfig = {
      activeProvider: "yandex",
      machineId: "x",
      machineName: "y",
      onboardingCompleted: true,
      syncPaused: false,
      providers: {},
    };
    const reg = new ProviderRegistry(() => Promise.resolve(cfg));
    const inst = new MockCloudProvider("yandex");
    const spy = vi.spyOn(inst, "isAuthenticated").mockResolvedValue(false);
    reg.register("yandex", () => inst);
    await expect(reg.isAuthenticatedFor("yandex")).resolves.toBe(false);
    spy.mockRestore();
  });
});
