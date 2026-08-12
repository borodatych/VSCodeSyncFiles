/**
 * Engine-level canonical key moves (docs/v3/canonicalPaths.md): cloud-only —
 * blob, `_meta` row and manifest pair move; the bytes on THIS disk stay where
 * they are and the local row follows by key (`manifestPath`).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { SyncEngine } from "../../src/core/syncEngine.js";
import { WorkspaceConfigManager } from "../../src/core/workspaceConfigManager.js";
import {
  manifestCloudPath,
  metaCloudPath,
  trackedFileCloudPath,
  type CloudManifest,
  type MetaJson,
} from "../../src/core/cloudLayout.js";
import { hashCanonicalBuffer } from "../../src/utils/hash.js";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots) {
    await fs.rm(r, { recursive: true, force: true });
  }
  roots.length = 0;
});

async function setup() {
  const provider = new MockCloudProvider("onedrive");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-canon-"));
  roots.push(root);
  const engine = new SyncEngine({
    workspaceRoot: root,
    provider,
    machineId: "M1",
    machineName: "test",
    trigger: "user",
  });
  const wsId = await engine.createWorkspace("canon-test", "onedrive");
  return { provider, root, engine, wsId };
}

async function addFile(root: string, engine: SyncEngine, wsId: string, relPath: string, content: string) {
  const abs = path.join(root, ...relPath.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  await engine.addFiles(wsId, [abs]);
  return abs;
}

async function cloudManifest(provider: MockCloudProvider, wsId: string): Promise<CloudManifest> {
  const dl = await provider.downloadFile(manifestCloudPath(wsId));
  return JSON.parse(dl.body.toString()) as CloudManifest;
}

async function cloudMeta(provider: MockCloudProvider, wsId: string): Promise<MetaJson> {
  const dl = await provider.downloadFile(metaCloudPath(wsId));
  return JSON.parse(dl.body.toString()) as MetaJson;
}

describe("renameCanonicalKeys — одиночный файл", () => {
  it("блоб/мета/манифест переезжают, локальные байты и localPath остаются", async () => {
    const { provider, root, engine, wsId } = await setup();
    const abs = await addFile(root, engine, wsId, "src/a.ts", "hello");

    const out = await engine.renameCanonicalKeys(wsId, [
      { scope: "file", from: "src/a.ts", to: "lib/moved.ts" },
    ]);
    expect(out.applied).toEqual([{ from: "src/a.ts", to: "lib/moved.ts" }]);

    // Cloud: blob at the new key, old key gone.
    const newBlob = await provider.downloadFile(trackedFileCloudPath(wsId, "lib/moved.ts"));
    expect(newBlob.body.toString()).toBe("hello");
    await expect(provider.downloadFile(trackedFileCloudPath(wsId, "src/a.ts"))).rejects.toThrow();

    // Manifest: tombstone + heir with shared identity.
    const m = await cloudManifest(provider, wsId);
    const tomb = m.files.find((f) => f.path === "src/a.ts");
    const heir = m.files.find((f) => f.path === "lib/moved.ts");
    expect(tomb?.removedAt).toBeTruthy();
    expect(heir?.renamedFrom).toBe("src/a.ts");
    expect(heir?.linkId).toBeTruthy();
    expect(heir?.linkId).toBe(tomb?.linkId);

    // `_meta`: row under the new key with the hash of the NEW key.
    const meta = await cloudMeta(provider, wsId);
    expect(meta.files["src/a.ts"]).toBeUndefined();
    expect(meta.files["lib/moved.ts"]?.hash).toBe(
      hashCanonicalBuffer(Buffer.from("hello", "utf8"), "lib/moved.ts", { lineEnding: "lf" }),
    );

    // Local: bytes did not move; the row follows by key.
    await expect(fs.readFile(abs, "utf8")).resolves.toBe("hello");
    const wc = await WorkspaceConfigManager.load(root);
    const row = wc.files.find((f) => f.workspaceId === wsId && f.localPath === "src/a.ts");
    expect(row?.manifestPath).toBe("lib/moved.ts");
    expect(row?.linkId).toBe(heir?.linkId);
  });

  it("идемпотентность: повторный запуск тех же requests — пустой applied, ничего не ломается", async () => {
    const { engine, root, wsId } = await setup();
    await addFile(root, engine, wsId, "src/a.ts", "hello");
    await engine.renameCanonicalKeys(wsId, [{ scope: "file", from: "src/a.ts", to: "lib/a.ts" }]);
    const again = await engine.renameCanonicalKeys(wsId, [{ scope: "file", from: "src/a.ts", to: "lib/a.ts" }]);
    expect(again.applied).toEqual([]);
  });
});

describe("renameCanonicalKeys — папка (префикс)", () => {
  it("все дочерние перестраиваются одним батчем с единым version", async () => {
    const { provider, root, engine, wsId } = await setup();
    await addFile(root, engine, wsId, "src/a.ts", "AAA");
    await addFile(root, engine, wsId, "src/deep/b.ts", "BBB");
    await addFile(root, engine, wsId, "other/c.ts", "CCC");

    const out = await engine.renameCanonicalKeys(wsId, [{ scope: "prefix", from: "src", to: "app" }]);
    expect(out.applied.map((m) => m.to).sort()).toEqual(["app/a.ts", "app/deep/b.ts"]);

    const m = await cloudManifest(provider, wsId);
    const touched = m.files.filter((f) => f.path.startsWith("app/") || f.path.startsWith("src/"));
    expect(new Set(touched.map((f) => f.version)).size).toBe(1);
    expect(m.files.find((f) => f.path === "other/c.ts")?.removedAt).toBeUndefined();

    const blobA = await provider.downloadFile(trackedFileCloudPath(wsId, "app/a.ts"));
    expect(blobA.body.toString()).toBe("AAA");

    // Local rows follow by key, bytes stay under src/.
    const wc = await WorkspaceConfigManager.load(root);
    const rowA = wc.files.find((f) => f.localPath === "src/a.ts");
    expect(rowA?.manifestPath).toBe("app/a.ts");
    await expect(fs.readFile(path.join(root, "src", "a.ts"), "utf8")).resolves.toBe("AAA");
  });
});

describe("renameCanonicalKeys — смена категории расширения", () => {
  it("текст → бинарь: _meta.hash пересчитан под новым ключом (CRLF больше не нормализуется)", async () => {
    const { provider, root, engine, wsId } = await setup();
    const content = "line1\r\nline2\r\n";
    await addFile(root, engine, wsId, "notes.txt", content);
    const metaBefore = await cloudMeta(provider, wsId);
    const oldHash = metaBefore.files["notes.txt"]?.hash;

    await engine.renameCanonicalKeys(wsId, [{ scope: "file", from: "notes.txt", to: "notes.png" }]);

    const metaAfter = await cloudMeta(provider, wsId);
    const newHash = metaAfter.files["notes.png"]?.hash;
    expect(newHash).toBeTruthy();
    expect(newHash).not.toBe(oldHash);
    expect(newHash).toBe(
      hashCanonicalBuffer(Buffer.from(content, "utf8"), "notes.png", { lineEnding: "lf" }),
    );
  });
});
