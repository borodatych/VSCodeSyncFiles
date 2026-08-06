/**
 * The engine must refuse blob work when encryption is on and no key reached it.
 *
 * This was the worst defect the audit found. `encrypt`/`decrypt` were optional,
 * so an engine built without them worked happily in plaintext — and the key
 * reached only 7 of 24 construction sites. Every automatic trigger built its
 * engine without one, which meant, with encryption enabled:
 *   - push uploaded plaintext over encrypted blobs and wrote a matching
 *     `_meta.hash`, so nothing ever noticed or corrected it;
 *   - pull wrote ciphertext straight over the user's local file.
 * It also explains the "sometimes it uploads, sometimes it doesn't" report:
 * manual commands went through a path that had the key, triggers did not.
 */
import { describe, expect, it } from "vitest";
import { SyncEngine } from "../../src/core/syncEngine.js";
import type { ICloudProvider } from "../../src/providers/cloudProviderTypes.js";

function providerStub(): ICloudProvider {
  const fail = (): never => {
    throw new Error("провайдер не должен вызываться: операция обязана быть отклонена раньше");
  };
  return {
    type: "onedrive",
    isAuthenticated: () => Promise.resolve(true),
    authenticate: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    uploadFile: fail,
    downloadFile: fail,
    getMetadata: fail,
    deleteFile: fail,
    listFolder: fail,
    createFolder: fail,
  } as unknown as ICloudProvider;
}

function makeEngine(opts: {
  encryptionRequired?: boolean;
  withKey?: boolean;
}): SyncEngine {
  const identity = (b: Buffer): Buffer => b;
  return new SyncEngine({
    workspaceRoot: "/tmp/vscodesync-guard-test",
    provider: providerStub(),
    machineId: "m1",
    machineName: "test-machine",
    trigger: "user",
    encryptionRequired: opts.encryptionRequired,
    encrypt: opts.withKey === true ? identity : undefined,
    decrypt: opts.withKey === true ? identity : undefined,
  });
}

const EMPTY_CFG = { activeWorkspaces: [], files: [] };

describe("движок отказывает, когда шифрование включено, а ключа нет", () => {
  it("pushFile отклоняется", async () => {
    const engine = makeEngine({ encryptionRequired: true, withKey: false });
    await expect(engine.pushFile(EMPTY_CFG, "ws1", "a.txt")).rejects.toThrow(
      /шифрование включено, но ключ недоступен/i,
    );
  });

  it("pullFile отклоняется", async () => {
    const engine = makeEngine({ encryptionRequired: true, withKey: false });
    await expect(engine.pullFile(EMPTY_CFG, "ws1", "a.txt")).rejects.toThrow(
      /шифрование включено, но ключ недоступен/i,
    );
  });

  it("сообщение объясняет, почему операция отменена", async () => {
    const engine = makeEngine({ encryptionRequired: true, withKey: false });
    const err = await engine.pushFile(EMPTY_CFG, "ws1", "a.txt").catch((e: unknown) => e);
    expect(String(err)).toContain("открытый текст");
    expect(String(err)).toContain("шифротекстом");
  });

  it("при выключенном шифровании отказа нет — работа идёт дальше по обычному пути", async () => {
    const engine = makeEngine({ encryptionRequired: false, withKey: false });
    const err = await engine.pushFile(EMPTY_CFG, "ws1", "a.txt").catch((e: unknown) => e);
    expect(String(err)).not.toContain("шифрование включено");
  });

  it("при включённом шифровании и наличии ключа отказа нет", async () => {
    const engine = makeEngine({ encryptionRequired: true, withKey: true });
    const err = await engine.pushFile(EMPTY_CFG, "ws1", "a.txt").catch((e: unknown) => e);
    expect(String(err)).not.toContain("шифрование включено");
  });
});
