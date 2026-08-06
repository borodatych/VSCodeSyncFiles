import * as fs from "node:fs/promises";
import { createTokenStore } from "../../src/providers/_shared/tokenStore.js";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GlobalConfigManager } from "../../src/core/globalConfigManager.js";
import type { SecretStore } from "../../src/core/types.js";

class MemorySecrets implements SecretStore {
  private readonly m = new Map<string, string>();
  get(key: string) {
    return Promise.resolve(this.m.get(key));
  }
  store(key: string, value: string) {
    this.m.set(key, value);
    return Promise.resolve();
  }
  delete(key: string) {
    this.m.delete(key);
    return Promise.resolve();
  }
}

describe("GlobalConfigManager", () => {
  let dir: string;
  let mgr: GlobalConfigManager;

  afterEach(async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("создаёт дефолт и атомарно сохраняет при первом load", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-gc-"));
    mgr = new GlobalConfigManager(dir, undefined);
    const cfg = await mgr.load();
    expect(cfg.machineId.length).toBeGreaterThan(10);
    expect(cfg.activeProvider).toBeNull();
    expect(cfg.onboardingCompleted).toBe(false);
    expect(cfg.syncPaused).toBe(false);
    const raw = await fs.readFile(mgr.getConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as { machineId: string };
    expect(parsed.machineId).toBe(cfg.machineId);
  });

  it("get/set + save", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-gc-"));
    mgr = new GlobalConfigManager(dir, undefined);
    await mgr.load();
    await mgr.set("activeProvider", "onedrive");
    await mgr.save();
    mgr.invalidateCache();
    const next = await mgr.load();
    expect(next.activeProvider).toBe("onedrive");
  });

  it("секреты не попадают в файл", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-gc-"));
    const secrets = new MemorySecrets();
    mgr = new GlobalConfigManager(dir, secrets);
    await mgr.load();
    // Tokens live in SecretStorage, never in config.json — the manager has no
    // token accessors of its own since stage 4.2 (E14).
    await createTokenStore(secrets, "onedrive").write({
      accessToken: "token-xyz",
      expiresAtMs: Date.now() + 1000,
    });
    const raw = await fs.readFile(mgr.getConfigPath(), "utf8");
    expect(raw.includes("token-xyz")).toBe(false);
    await expect(createTokenStore(secrets, "onedrive").read()).resolves.toMatchObject({
      accessToken: "token-xyz",
    });
  });

  it("старый config без onboardingCompleted → миграция true", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-gc-"));
    const filePath = path.join(dir, "config.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        machineId: "legacy-id",
        machineName: "legacy",
        activeProvider: null,
        providers: {},
      }),
      "utf8",
    );
    mgr = new GlobalConfigManager(dir, undefined);
    const cfg = await mgr.load();
    expect(cfg.onboardingCompleted).toBe(true);
    expect(cfg.machineId).toBe("legacy-id");
  });
});
