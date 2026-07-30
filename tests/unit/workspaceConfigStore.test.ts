/**
 * The config file has exactly one owner.
 *
 * Every mutation used to be an open read-modify-write: load from disk, mutate
 * the object, write it back. With `sync.workspaceConcurrency` defaulting to 2
 * two workspace branches interleave those steps and the later write silently
 * discards what the earlier one recorded. The atomic write's temp name was not
 * unique within a millisecond either, so the two could collide on one temp path.
 */
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "../../src/core/types.js";
import {
  getWorkspaceConfigStore,
  resetWorkspaceConfigStores,
} from "../../src/core/workspaceConfigStore.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vscodesync-cfg-"));
}

async function readRaw(root: string): Promise<WorkspaceConfig> {
  const raw = await readFile(join(root, ".vscode", "vscodesync.json"), "utf8");
  return JSON.parse(raw) as WorkspaceConfig;
}

afterEach(() => {
  resetWorkspaceConfigStores();
});

describe("workspaceConfigStore", () => {
  it("отсутствующий файл читается как пустая конфигурация", async () => {
    const root = await tempRoot();
    const cfg = await getWorkspaceConfigStore(root).load();
    expect(cfg.activeWorkspaces).toEqual([]);
    expect(cfg.files).toEqual([]);
  });

  it("конкурентные mutate не теряют изменения друг друга", async () => {
    // The regression this store exists for: 20 interleaved read-modify-writes
    // used to end with a file containing far fewer than 20 entries.
    const root = await tempRoot();
    const store = getWorkspaceConfigStore(root);
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.mutate((cfg) => {
          cfg.activeWorkspaces.push({
            workspaceId: `ws-${String(i)}`,
            workspaceNote: `note ${String(i)}`,
          });
        }),
      ),
    );
    const onDisk = await readRaw(root);
    expect(onDisk.activeWorkspaces).toHaveLength(N);
    const ids = new Set(onDisk.activeWorkspaces.map((w) => w.workspaceId));
    expect(ids.size).toBe(N);
  });

  it("mutate видит результат предыдущего mutate, а не устаревший снимок", async () => {
    const root = await tempRoot();
    const store = getWorkspaceConfigStore(root);
    const seen: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, () =>
        store.mutate((cfg) => {
          seen.push(cfg.activeWorkspaces.length);
          cfg.activeWorkspaces.push({ workspaceId: "x", workspaceNote: "n" });
        }),
      ),
    );
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("ошибка внутри mutate не отравляет очередь", async () => {
    const root = await tempRoot();
    const store = getWorkspaceConfigStore(root);
    await expect(
      store.mutate(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await store.mutate((cfg) => {
      cfg.activeWorkspaces.push({ workspaceId: "after", workspaceNote: "n" });
    });
    const onDisk = await readRaw(root);
    expect(onDisk.activeWorkspaces.map((w) => w.workspaceId)).toEqual(["after"]);
  });

  it("правка файла извне подхватывается — кэш проверяется по mtime", async () => {
    // A second VS Code window, a manual edit or a git checkout can rewrite the
    // file; serving the in-memory copy blindly would hide that.
    const root = await tempRoot();
    const store = getWorkspaceConfigStore(root);
    await store.save({ activeWorkspaces: [], files: [] });
    expect((await store.load()).activeWorkspaces).toHaveLength(0);

    await mkdir(join(root, ".vscode"), { recursive: true });
    await new Promise((r) => setTimeout(r, 12));
    await writeFile(
      join(root, ".vscode", "vscodesync.json"),
      JSON.stringify({
        activeWorkspaces: [{ workspaceId: "outside", workspaceNote: "n" }],
        files: [],
      }),
      "utf8",
    );

    const reloaded = await store.load();
    expect(reloaded.activeWorkspaces.map((w) => w.workspaceId)).toEqual(["outside"]);
  });

  it("один и тот же корень в разном написании даёт одного владельца", async () => {
    const root = await tempRoot();
    const a = getWorkspaceConfigStore(root);
    const b = getWorkspaceConfigStore(`${root}/`);
    await a.mutate((cfg) => {
      cfg.activeWorkspaces.push({ workspaceId: "shared", workspaceNote: "n" });
    });
    expect((await b.load()).activeWorkspaces.map((w) => w.workspaceId)).toEqual(["shared"]);
  });
});
