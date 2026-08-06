/**
 * Snapshots must respect E2E encryption (этап 5.0).
 *
 * Before this, `createWorkspaceSnapshot` uploaded every tracked file as
 * plaintext regardless of `vscodesync.encryption`, so a workspace whose blobs
 * were encrypted still had a readable copy in the cloud — and three of the
 * callers are automatic.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { SyncEngine } from "../../src/core/syncEngine.js";
import {
  createWorkspaceSnapshot,
  restoreWorkspaceSnapshot,
  SnapshotEncryptionUnavailableError,
  type SnapshotCrypto,
} from "../../src/core/snapshotsEngine.js";
import { snapshotFilePath, snapshotMetaCloudPath } from "../../src/core/cloudLayout.js";
import { encryptBuffer, decryptBuffer, generateEncryptionKey } from "../../src/core/encryption.js";

const KEY = generateEncryptionKey();
const encrypted: SnapshotCrypto = {
  required: true,
  encrypt: (b) => encryptBuffer(KEY, b),
  decrypt: (b) => decryptBuffer(KEY, b),
};
const plaintext: SnapshotCrypto = { required: false };

const SECRET = "TOP-SECRET-CONTENT\n";

async function setupWorkspace(): Promise<{
  provider: MockCloudProvider;
  root: string;
  wid: string;
  rel: string;
}> {
  const provider = new MockCloudProvider("onedrive");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-snap-"));
  const engine = new SyncEngine({
    workspaceRoot: root,
    provider,
    machineId: "A",
    machineName: "A",
    trigger: "user",
  });
  const wid = await engine.createWorkspace("snap-test", "onedrive");
  const rel = "notes/secret.txt";
  const abs = path.join(root, "notes", "secret.txt");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, SECRET, "utf8");
  await engine.addFiles(wid, [abs]);
  return { provider, root, wid, rel };
}

describe("снапшоты и E2E-шифрование", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
  });

  it("при шифровании содержимое файла не лежит в облаке открытым текстом", async () => {
    const { provider, root, wid, rel } = await setupWorkspace();
    roots.push(root);

    const name = await createWorkspaceSnapshot(provider, root, wid, "snap", "A", encrypted);

    const blob = await provider.downloadFile(snapshotFilePath(wid, name, rel));
    expect(blob.body.toString("utf8")).not.toContain("TOP-SECRET");
    expect(decryptBuffer(KEY, blob.body).toString("utf8")).toBe(SECRET);

    const meta = JSON.parse(
      (await provider.downloadFile(snapshotMetaCloudPath(wid, name))).body.toString("utf8"),
    ) as { encryption?: string };
    expect(meta.encryption).toBe("aes-256-gcm");
  });

  it("без шифрования формат прежний и поле encryption отсутствует", async () => {
    const { provider, root, wid, rel } = await setupWorkspace();
    roots.push(root);

    const name = await createWorkspaceSnapshot(provider, root, wid, "snap", "A", plaintext);

    const blob = await provider.downloadFile(snapshotFilePath(wid, name, rel));
    expect(blob.body.toString("utf8")).toBe(SECRET);
    const meta = JSON.parse(
      (await provider.downloadFile(snapshotMetaCloudPath(wid, name))).body.toString("utf8"),
    ) as { encryption?: string };
    expect(meta.encryption).toBeUndefined();
  });

  it("шифрование включено, ключа нет → отказ, в облаке ничего не появилось", async () => {
    const { provider, root, wid } = await setupWorkspace();
    roots.push(root);

    await expect(
      createWorkspaceSnapshot(provider, root, wid, "snap", "A", { required: true }),
    ).rejects.toBeInstanceOf(SnapshotEncryptionUnavailableError);
    await expect(
      provider.downloadFile(snapshotMetaCloudPath(wid, "snap")),
    ).rejects.toBeTruthy();
  });

  it("restore расшифровывает свой снапшот", async () => {
    const { provider, root, wid, rel } = await setupWorkspace();
    roots.push(root);
    const name = await createWorkspaceSnapshot(provider, root, wid, "snap", "A", encrypted);

    const abs = path.join(root, ...rel.split("/"));
    await fs.writeFile(abs, "LOCAL-DAMAGE\n", "utf8");
    const r = await restoreWorkspaceSnapshot(provider, root, wid, name, "A", encrypted);

    expect(r.restoredCount).toBe(1);
    await expect(fs.readFile(abs, "utf8")).resolves.toBe(SECRET);
  });

  it("старый (незашифрованный) снапшот восстанавливается и при включённом шифровании", async () => {
    const { provider, root, wid, rel } = await setupWorkspace();
    roots.push(root);
    // Written the old way: no `encryption` field, blobs in the clear.
    const name = await createWorkspaceSnapshot(provider, root, wid, "legacy", "A", plaintext);

    const abs = path.join(root, ...rel.split("/"));
    await fs.writeFile(abs, "LOCAL-DAMAGE\n", "utf8");
    const r = await restoreWorkspaceSnapshot(provider, root, wid, name, "A", encrypted);

    expect(r.restoredCount).toBe(1);
    await expect(fs.readFile(abs, "utf8")).resolves.toBe(SECRET);
  });

  it("зашифрованный снапшот без ключа не восстанавливается и не портит локальный файл", async () => {
    const { provider, root, wid, rel } = await setupWorkspace();
    roots.push(root);
    const name = await createWorkspaceSnapshot(provider, root, wid, "snap", "A", encrypted);

    const abs = path.join(root, ...rel.split("/"));
    await fs.writeFile(abs, "LOCAL-EDIT\n", "utf8");
    await expect(
      restoreWorkspaceSnapshot(provider, root, wid, name, "A", { required: true }),
    ).rejects.toBeInstanceOf(SnapshotEncryptionUnavailableError);
    await expect(fs.readFile(abs, "utf8")).resolves.toBe("LOCAL-EDIT\n");
  });
});
