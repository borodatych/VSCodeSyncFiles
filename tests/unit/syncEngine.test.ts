import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { SyncEngine } from "../../src/core/syncEngine.js";
import { WorkspaceConfigManager } from "../../src/core/workspaceConfigManager.js";
import { manifestCloudPath, workspaceRootPath } from "../../src/core/cloudLayout.js";

describe("SyncEngine (mock)", () => {
  let localRoot: string | undefined;

  afterEach(async () => {
    if (localRoot !== undefined) {
      await fs.rm(localRoot, { recursive: true, force: true });
    }
    localRoot = undefined;
  });

  it("attachCloudWorkspace: вторая машина подключается с облака и получает файлы из манифеста", async () => {
    const provider = new MockCloudProvider("onedrive");
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-b-"));
    try {
      const engineA = new SyncEngine({
        workspaceRoot: rootA,
        provider,
        machineId: "machine-a",
        machineName: "A",
      });
      const wid = await engineA.createWorkspace("attach-test", "onedrive");
      const rel = "doc.txt";
      const absA = path.join(rootA, rel);
      await fs.writeFile(absA, "content\n", "utf8");
      await engineA.addFiles(wid, [absA]);

      const engineB = new SyncEngine({
        workspaceRoot: rootB,
        provider,
        machineId: "machine-b",
        machineName: "B",
      });
      const list = await engineB.listRemoteWorkspaceSummaries();
      expect(list.some((x) => x.workspaceId === wid)).toBe(true);
      await engineB.attachCloudWorkspace(wid);

      const absB = path.join(rootB, rel);
      await expect(fs.readFile(absB, "utf8")).resolves.toBe("content\n");
      const cfgB = await WorkspaceConfigManager.load(rootB);
      expect(cfgB.activeWorkspaces.some((w) => w.workspaceId === wid)).toBe(true);
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it("две машины: общий mock cloud — первый pull пустого клиента → затем правка на B → pull на A", async () => {
    const provider = new MockCloudProvider("onedrive");
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-b-"));
    try {
      const engineA = new SyncEngine({
        workspaceRoot: rootA,
        provider,
        machineId: "machine-a",
        machineName: "A",
      });
      const wid = await engineA.createWorkspace("two-machine", "onedrive");
      const rel = "shared.txt";
      const absA = path.join(rootA, rel);
      await fs.writeFile(absA, "from-a\n", "utf8");
      await engineA.addFiles(wid, [absA]);

      const cfgFromA = await WorkspaceConfigManager.load(rootA);
      await WorkspaceConfigManager.save(structuredClone(cfgFromA), rootB);

      const engineB = new SyncEngine({
        workspaceRoot: rootB,
        provider,
        machineId: "machine-b",
        machineName: "B",
      });
      await engineB.pullAll(wid);

      const absB = path.join(rootB, rel);
      await expect(fs.readFile(absB, "utf8")).resolves.toBe("from-a\n");

      await fs.writeFile(absB, "from-b\n", "utf8");
      await engineB.pushAll(wid);

      await engineA.pullAll(wid);
      await expect(fs.readFile(absA, "utf8")).resolves.toBe("from-b\n");
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it("create → add file → pull meta roundtrip", async () => {
    localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-"));
    const provider = new MockCloudProvider("onedrive");
    const engine = new SyncEngine({
      workspaceRoot: localRoot,
      provider,
      machineId: "m1",
      machineName: "test",
    });
    const wid = await engine.createWorkspace("t", "onedrive");
    const f = path.join(localRoot, "a.txt");
    await fs.writeFile(f, "hello\n", "utf8");
    await engine.addFiles(wid, [f]);
    const cfg = await WorkspaceConfigManager.load(localRoot);
    expect(cfg.files.length).toBe(1);
    expect(cfg.files[0]?.localHash.length).toBe(64);
  });

  it("detachWorkspaceLocal очищает activeWorkspaces и files локально", async () => {
    localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-"));
    const provider = new MockCloudProvider("onedrive");
    const engine = new SyncEngine({
      workspaceRoot: localRoot,
      provider,
      machineId: "m1",
      machineName: "test",
    });
    const wid = await engine.createWorkspace("w", "onedrive");
    const f = path.join(localRoot, "a.txt");
    await fs.writeFile(f, "x\n", "utf8");
    await engine.addFiles(wid, [f]);
    await engine.detachWorkspaceLocal(wid);
    const cfg = await WorkspaceConfigManager.load(localRoot);
    expect(cfg.activeWorkspaces).toHaveLength(0);
    expect(cfg.files).toHaveLength(0);
  });

  it("renameWorkspaceNote обновляет манифест и локальный конфиг", async () => {
    localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-"));
    const provider = new MockCloudProvider("onedrive");
    const engine = new SyncEngine({
      workspaceRoot: localRoot,
      provider,
      machineId: "m1",
      machineName: "test",
    });
    const wid = await engine.createWorkspace("old-note", "onedrive");
    await engine.renameWorkspaceNote(wid, "new-note");
    const cfg = await WorkspaceConfigManager.load(localRoot);
    expect(cfg.activeWorkspaces[0]?.workspaceNote).toBe("new-note");
    const dl = await provider.downloadFile(manifestCloudPath(wid));
    const m = JSON.parse(dl.body.toString("utf8")) as { workspaceNote: string };
    expect(m.workspaceNote).toBe("new-note");
  });

  it("previewSyncPlan: не меняет локальный конфиг и показывает push после правки без push", async () => {
    localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-"));
    const provider = new MockCloudProvider("onedrive");
    const engine = new SyncEngine({
      workspaceRoot: localRoot,
      provider,
      machineId: "m1",
      machineName: "test",
    });
    const wid = await engine.createWorkspace("pv", "onedrive");
    const f = path.join(localRoot, "x.txt");
    await fs.writeFile(f, "v1\n", "utf8");
    await engine.addFiles(wid, [f]);
    const cfgBefore = await WorkspaceConfigManager.load(localRoot);
    const etagBefore = cfgBefore.activeWorkspaces[0]?.manifestEtag;

    const planOk = await engine.previewSyncPlan(wid);
    const cfgAfterPreview = await WorkspaceConfigManager.load(localRoot);
    expect(cfgAfterPreview.activeWorkspaces[0]?.manifestEtag).toBe(etagBefore);
    expect(planOk[0]?.files.find((r) => r.localPath === "x.txt")?.action).toBe("none");

    await fs.writeFile(f, "v2\n", "utf8");
    const planPush = await engine.previewSyncPlan(wid);
    expect(planPush[0]?.files.find((r) => r.localPath === "x.txt")?.action).toBe("push");
  });

  it("addFiles отклоняет файл больше maxFileSizeBytes", async () => {
    localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-"));
    const provider = new MockCloudProvider("onedrive");
    const engine = new SyncEngine({
      workspaceRoot: localRoot,
      provider,
      machineId: "m1",
      machineName: "test",
      maxFileSizeBytes: 4,
    });
    const wid = await engine.createWorkspace("t", "onedrive");
    const f = path.join(localRoot, "big.txt");
    await fs.writeFile(f, "hello\n", "utf8");
    await expect(engine.addFiles(wid, [f])).rejects.toThrow(/слишком большой/i);
  });

  it("Suspend блокирует pushFile", async () => {
    localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-"));
    const provider = new MockCloudProvider("onedrive");
    const engine = new SyncEngine({
      workspaceRoot: localRoot,
      provider,
      machineId: "m1",
      machineName: "test",
    });
    const wid = await engine.createWorkspace("t", "onedrive");
    const f = path.join(localRoot, "a.txt");
    await fs.writeFile(f, "hello\n", "utf8");
    await engine.addFiles(wid, [f]);
    await engine.setWorkspaceSyncState(wid, "suspended");
    const cfg = await WorkspaceConfigManager.load(localRoot);
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === wid);
    if (!entry) {
      throw new Error("missing entry");
    }
    await fs.writeFile(f, "changed\n", "utf8");
    await expect(engine.pushFile(cfg, wid, "a.txt", entry)).rejects.toThrow(/Suspend/i);
  });

  it("Freeze блокирует запись манифеста (renameWorkspaceNote)", async () => {
    localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-"));
    const provider = new MockCloudProvider("onedrive");
    const engine = new SyncEngine({
      workspaceRoot: localRoot,
      provider,
      machineId: "m1",
      machineName: "test",
    });
    const wid = await engine.createWorkspace("w", "onedrive");
    await engine.setWorkspaceSyncState(wid, "frozen");
    await expect(engine.renameWorkspaceNote(wid, "next")).rejects.toThrow(/Freeze/i);
  });

  it("deleteWorkspaceFromCloud удаляет объекты под префиксом и отключает workspace локально", async () => {
    localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-"));
    const provider = new MockCloudProvider("onedrive");
    const engine = new SyncEngine({
      workspaceRoot: localRoot,
      provider,
      machineId: "m1",
      machineName: "test",
    });
    const wid = await engine.createWorkspace("del-me", "onedrive");
    const f = path.join(localRoot, "a.txt");
    await fs.writeFile(f, "x\n", "utf8");
    await engine.addFiles(wid, [f]);
    expect(provider.files.size).toBeGreaterThan(0);
    await engine.deleteWorkspaceFromCloud(wid);
    const cfg = await WorkspaceConfigManager.load(localRoot);
    expect(cfg.activeWorkspaces).toHaveLength(0);
    expect(cfg.files).toHaveLength(0);
    const prefix = workspaceRootPath(wid);
    const leaked = [...provider.files.keys()].filter((k) => k === prefix || k.startsWith(`${prefix}/`));
    expect(leaked).toEqual([]);
  });

  it("requireMachineApproval: новая машина pending и не может push", async () => {
    const provider = new MockCloudProvider("onedrive");
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-ap-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-ap-b-"));
    try {
      const engineA = new SyncEngine({
        workspaceRoot: rootA,
        provider,
        machineId: "machine-a",
        machineName: "A",
      });
      const wid = await engineA.createWorkspace("approval-flow", "onedrive");
      const rel = "doc.txt";
      const absA = path.join(rootA, rel);
      await fs.writeFile(absA, "base\n", "utf8");
      await engineA.addFiles(wid, [absA]);

      await WorkspaceConfigManager.save({ activeWorkspaces: [], files: [] }, rootB);

      const engineB = new SyncEngine({
        workspaceRoot: rootB,
        provider,
        machineId: "machine-b",
        machineName: "B-new",
        requireMachineApproval: () => true,
      });
      await engineB.attachCloudWorkspace(wid);

      const manifestDl = await provider.downloadFile(manifestCloudPath(wid));
      const manifest = JSON.parse(manifestDl.body.toString("utf8")) as {
        machines: { machineId: string; status?: string }[];
      };
      expect(manifest.machines.find((x) => x.machineId === "machine-b")?.status).toBe("pending");

      const absB = path.join(rootB, rel);
      await fs.writeFile(absB, "edited\n", "utf8");
      await expect(engineB.pushAll(wid)).rejects.toThrow(/ожидает подтверждения/i);
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it("pushFile не заливает устаревший локальный файл в облако — тянет новую версию с облака", async () => {
    const provider = new MockCloudProvider("onedrive");
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-stale-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-stale-b-"));
    try {
      const engineA = new SyncEngine({
        workspaceRoot: rootA,
        provider,
        machineId: "machine-a",
        machineName: "A",
      });
      const wid = await engineA.createWorkspace("stale-push-guard", "onedrive");
      const rel = "stale.txt";
      const absA = path.join(rootA, rel);
      await fs.writeFile(absA, "version-one\n", "utf8");
      await engineA.addFiles(wid, [absA]);

      const cfgFromA = await WorkspaceConfigManager.load(rootA);
      await WorkspaceConfigManager.save(structuredClone(cfgFromA), rootB);

      const engineB = new SyncEngine({
        workspaceRoot: rootB,
        provider,
        machineId: "machine-b",
        machineName: "B",
      });
      await engineB.pullAll(wid);
      const absB = path.join(rootB, rel);
      await expect(fs.readFile(absB, "utf8")).resolves.toBe("version-one\n");

      await fs.writeFile(absA, "version-two-from-work\n", "utf8");
      await engineA.pushAll(wid);

      expect(await fs.readFile(absB, "utf8")).toBe("version-one\n");

      const cfgB = await WorkspaceConfigManager.load(rootB);
      const entry = cfgB.activeWorkspaces.find((w) => w.workspaceId === wid);
      if (!entry) {
        throw new Error("missing entry");
      }
      await engineB.pushFile(cfgB, wid, rel, entry);

      await expect(fs.readFile(absB, "utf8")).resolves.toBe("version-two-from-work\n");
      const cloudAfter = await provider.downloadFile(cfgB.files[0].cloudPath);
      expect(cloudAfter.body.toString("utf8")).toBe("version-two-from-work\n");
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it("mergeWorkspaces: переносит disjoint файлы в цель и при deleteSource сносит источник на облаке", async () => {
    localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-merge-"));
    const provider = new MockCloudProvider("onedrive");
    const engine = new SyncEngine({
      workspaceRoot: localRoot,
      provider,
      machineId: "m-merge",
      machineName: "test",
    });
    const wsSrc = await engine.createWorkspace("src-merge", "onedrive");
    const wsTgt = await engine.createWorkspace("tgt-merge", "onedrive");
    const fa = path.join(localRoot, "merge-a.txt");
    const fb = path.join(localRoot, "merge-b.txt");
    await fs.writeFile(fa, "a\n", "utf8");
    await fs.writeFile(fb, "b\n", "utf8");
    await engine.addFiles(wsSrc, [fa]);
    await engine.addFiles(wsTgt, [fb]);

    await engine.mergeWorkspaces(wsSrc, wsTgt, { deleteSourceWorkspace: true });

    const cfg = await WorkspaceConfigManager.load(localRoot);
    expect(cfg.activeWorkspaces).toHaveLength(1);
    expect(cfg.activeWorkspaces[0]?.workspaceId).toBe(wsTgt);
    expect(cfg.files.every((f) => f.workspaceId === wsTgt)).toBe(true);
    const tracked = [...new Set(cfg.files.map((f) => f.localPath))].sort();
    expect(tracked).toEqual(["merge-a.txt", "merge-b.txt"].sort());

    const tgtMan = JSON.parse((await provider.downloadFile(manifestCloudPath(wsTgt))).body.toString("utf8")) as {
      files: { path: string; removedAt?: string }[];
    };
    const tgtPaths = tgtMan.files
      .filter((f) => !f.removedAt)
      .map((f) => f.path)
      .sort();
    expect(tgtPaths).toEqual(["merge-a.txt", "merge-b.txt"].sort());

    expect(provider.files.has(manifestCloudPath(wsSrc))).toBe(false);
  });
});
