import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { SyncEngine } from "../../src/core/syncEngine.js";
import { WorkspaceConfigManager } from "../../src/core/workspaceConfigManager.js";
import { historyDirForFile } from "../../src/core/cloudLayout.js";
import { LOCAL_BACKUP_DIR_DEFAULT } from "../../src/core/localFileBackup.js";
import type { AttachDivergenceChoice } from "../../src/core/attachDivergence.js";

const REL = "doc.txt";
const CLOUD = "cloud\n";
const LOCAL = "local\n";

const roots: string[] = [];

async function tmpRoot(prefix: string): Promise<string> {
  const r = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(r);
  return r;
}

function engineAt(root: string, provider: MockCloudProvider, id: string): SyncEngine {
  return new SyncEngine({ workspaceRoot: root, provider, machineId: id, machineName: id, trigger: "user" });
}

/** Машина A кладёт файл в облако; машина B держит на диске свою версию того же пути */
async function setup(localOnB: string | undefined): Promise<{
  provider: MockCloudProvider;
  wid: string;
  rootB: string;
  engineB: SyncEngine;
}> {
  const provider = new MockCloudProvider("onedrive");
  const rootA = await tmpRoot("vsc-att-a-");
  const rootB = await tmpRoot("vsc-att-b-");
  const engineA = engineAt(rootA, provider, "machine-a");
  const wid = await engineA.createWorkspace("attach-div", "onedrive");
  await fs.writeFile(path.join(rootA, REL), CLOUD, "utf8");
  await engineA.addFiles(wid, [path.join(rootA, REL)]);
  if (localOnB !== undefined) {
    await fs.writeFile(path.join(rootB, REL), localOnB, "utf8");
  }
  return { provider, wid, rootB, engineB: engineAt(rootB, provider, "machine-b") };
}

function uploadsOf(spy: { mock: { calls: unknown[][] } }, rel: string): unknown[][] {
  return spy.mock.calls.filter((c) => {
    const p = String(c[0]);
    return p.endsWith(`/${rel}`) && !p.includes("/.history/");
  });
}

async function statusOf(root: string, rel: string): Promise<string | undefined> {
  const cfg = await WorkspaceConfigManager.load(root);
  return cfg.files.find((f) => f.localPath === rel)?.syncStatus;
}

function historyContents(provider: MockCloudProvider, wid: string): string[] {
  const dir = historyDirForFile(wid, REL);
  return [...provider.files.entries()].filter(([k]) => k.startsWith(dir)).map(([, v]) => v.content.toString("utf8"));
}

describe("attachCloudWorkspace: файлы на диске уже есть", () => {
  afterEach(async () => {
    for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("отличающийся файл и ответ none: в облако ничего не ушло, статус cloud_newer, диск не тронут", async () => {
    const { provider, wid, rootB, engineB } = await setup(LOCAL);
    const upload = vi.spyOn(provider, "uploadFile");
    const ask = vi.fn((): Promise<AttachDivergenceChoice> => Promise.resolve("none"));
    await engineB.attachCloudWorkspace(wid, { onDivergedAfterAttach: ask });

    expect(ask).toHaveBeenCalledWith({ workspaceId: wid, count: 1, samplePaths: [REL] });
    expect(uploadsOf(upload, REL)).toEqual([]);
    expect(await statusOf(rootB, REL)).toBe("cloud_newer");
    await expect(fs.readFile(path.join(rootB, REL), "utf8")).resolves.toBe(LOCAL);
  });

  it("без колбэка — то же: ничего не двигается", async () => {
    const { provider, wid, rootB, engineB } = await setup(LOCAL);
    const upload = vi.spyOn(provider, "uploadFile");
    await engineB.attachCloudWorkspace(wid);
    expect(uploadsOf(upload, REL)).toEqual([]);
    await expect(fs.readFile(path.join(rootB, REL), "utf8")).resolves.toBe(LOCAL);
  });

  it("take_cloud: локальный перезаписан облачным, прежняя локальная версия в бэкапе", async () => {
    const { provider, wid, rootB, engineB } = await setup(LOCAL);
    const upload = vi.spyOn(provider, "uploadFile");
    await engineB.attachCloudWorkspace(wid, { onDivergedAfterAttach: () => Promise.resolve("take_cloud") });

    expect(uploadsOf(upload, REL)).toEqual([]);
    await expect(fs.readFile(path.join(rootB, REL), "utf8")).resolves.toBe(CLOUD);
    expect(await statusOf(rootB, REL)).toBe("ok");
    const backupRoot = path.join(rootB, LOCAL_BACKUP_DIR_DEFAULT);
    const backups = (await fs.readdir(backupRoot, { recursive: true })).filter((p) => p.endsWith(REL));
    expect(backups.length).toBe(1);
    await expect(fs.readFile(path.join(backupRoot, backups[0]), "utf8")).resolves.toBe(LOCAL);
  });

  it("push_local: облако получило локальное, облачная версия в истории", async () => {
    const { provider, wid, rootB, engineB } = await setup(LOCAL);
    const upload = vi.spyOn(provider, "uploadFile");
    await engineB.attachCloudWorkspace(wid, { onDivergedAfterAttach: () => Promise.resolve("push_local") });

    const sent = uploadsOf(upload, REL);
    expect(sent.length).toBe(1);
    expect((sent[0][1] as Buffer).toString("utf8")).toBe(LOCAL);
    expect(historyContents(provider, wid)).toContain(CLOUD);
    await expect(fs.readFile(path.join(rootB, REL), "utf8")).resolves.toBe(LOCAL);
    expect(await statusOf(rootB, REL)).toBe("ok");
  });

  it("совпадающий файл: статус ok, вопроса нет, ничего не двигается", async () => {
    const { provider, wid, rootB, engineB } = await setup(CLOUD);
    const upload = vi.spyOn(provider, "uploadFile");
    const ask = vi.fn((): Promise<AttachDivergenceChoice> => Promise.resolve("push_local"));
    await engineB.attachCloudWorkspace(wid, { onDivergedAfterAttach: ask });

    expect(ask).not.toHaveBeenCalled();
    expect(uploadsOf(upload, REL)).toEqual([]);
    expect(await statusOf(rootB, REL)).toBe("ok");
  });

  it("файла нет на диске: скачан без вопроса", async () => {
    const { wid, rootB, engineB } = await setup(undefined);
    const ask = vi.fn((): Promise<AttachDivergenceChoice> => Promise.resolve("none"));
    await engineB.attachCloudWorkspace(wid, { onDivergedAfterAttach: ask });

    expect(ask).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(rootB, REL), "utf8")).resolves.toBe(CLOUD);
    expect(await statusOf(rootB, REL)).toBe("ok");
  });

  it("обычный проход после приёма отличающегося файла его не отправляет", async () => {
    const { provider, wid, rootB, engineB } = await setup(LOCAL);
    await engineB.attachCloudWorkspace(wid);
    const upload = vi.spyOn(provider, "uploadFile");
    await engineB.syncWorkspace(wid);
    expect(uploadsOf(upload, REL)).toEqual([]);
    expect(await statusOf(rootB, REL)).toBe("cloud_newer");
    await expect(fs.readFile(path.join(rootB, REL), "utf8")).resolves.toBe(LOCAL);
  });
});

describe("pushFile: ручная отправка", () => {
  afterEach(async () => {
    for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("userForce на cloud_newer: загружено локальное, диск не тронут, облачная версия в истории", async () => {
    const { provider, wid, rootB, engineB } = await setup(LOCAL);
    await engineB.attachCloudWorkspace(wid);
    expect(await statusOf(rootB, REL)).toBe("cloud_newer");
    const upload = vi.spyOn(provider, "uploadFile");
    const download = vi.spyOn(engineB, "pullFile");

    const cfg = await WorkspaceConfigManager.load(rootB);
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === wid);
    await engineB.pushFile(cfg, wid, REL, entry, { userForce: true });

    const sent = uploadsOf(upload, REL);
    expect(sent.length).toBe(1);
    expect((sent[0][1] as Buffer).toString("utf8")).toBe(LOCAL);
    expect(download).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(rootB, REL), "utf8")).resolves.toBe(LOCAL);
    expect(historyContents(provider, wid)).toContain(CLOUD);
  });

  it("без режима на consensus_lag — прежнее поведение: скачивает, а не отправляет", async () => {
    const { provider, wid, rootB, engineB } = await setup(LOCAL);
    await engineB.attachCloudWorkspace(wid);
    const upload = vi.spyOn(provider, "uploadFile");

    const cfg = await WorkspaceConfigManager.load(rootB);
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === wid);
    await engineB.pushFile(cfg, wid, REL, entry);

    expect(uploadsOf(upload, REL)).toEqual([]);
    await expect(fs.readFile(path.join(rootB, REL), "utf8")).resolves.toBe(CLOUD);
  });
});
