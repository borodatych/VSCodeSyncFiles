import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ProviderType } from "../../../src/core/types.js";
import { MockCloudProvider } from "../../../src/providers/mockCloudProvider.js";

const PROVIDER_TYPES: ProviderType[] = ["onedrive", "gdrive", "yandex", "dropbox"];

/**
 * Контракт ICloudProvider (mock) для каждого типа — см. docs/v1/05-providers/roadmap § «Integration-тесты с mock».
 */
async function assertMockProviderRoundtrip(providerType: ProviderType): Promise<void> {
  const p = new MockCloudProvider(providerType);
  assert.strictEqual(await p.isAuthenticated(), true);
  const path = `VSCodeSyncFiles/_integration_${providerType}/probe.txt`;
  await p.uploadFile(path, Buffer.from(providerType));
  const listed = await p.listFolder("VSCodeSyncFiles/");
  assert.ok(
    listed.some((m) => m.cloudPath === path),
    `listFolder должен видеть ${path}`,
  );
  const dl = await p.downloadFile(path);
  assert.strictEqual(dl.body.toString(), providerType);
  await p.deleteFile(path);
  await assert.rejects(p.downloadFile(path));
}

export async function run(): Promise<void> {
  assert.ok(vscode.workspace);
  const ext = vscode.extensions.getExtension("vscodesync.vscodesync");
  assert.ok(ext, "расширение vscodesync.vscodesync должно быть в списке");
  await ext.activate();
  assert.strictEqual(ext.isActive, true, "расширение должно активироваться без ошибок");

  for (const t of PROVIDER_TYPES) {
    await assertMockProviderRoundtrip(t);
  }
}
