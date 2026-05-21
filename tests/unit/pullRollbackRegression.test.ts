import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { SyncEngine } from "../../src/core/syncEngine.js";
import { WorkspaceConfigManager } from "../../src/core/workspaceConfigManager.js";

describe("Pull rollback regression — softlock + check-only must not flip status back", () => {
  let rootA: string | undefined;
  let rootB: string | undefined;

  afterEach(async () => {
    if (rootA !== undefined) {
      await fs.rm(rootA, { recursive: true, force: true });
    }
    if (rootB !== undefined) {
      await fs.rm(rootB, { recursive: true, force: true });
    }
    rootA = undefined;
    rootB = undefined;
  });

  it("manual Pull while remote machine still holds soft lock → checkWorkspaceStatus keeps 'ok'", async () => {
    const provider = new MockCloudProvider("onedrive");
    rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-roll-a-"));
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-roll-b-"));

    const engineA = new SyncEngine({
      workspaceRoot: rootA,
      provider,
      machineId: "machine-a",
      machineName: "059-1-ws-346",
    });
    const wid = await engineA.createWorkspace("rollback-repro", "onedrive");
    const rel = "shared.txt";
    const absA = path.join(rootA, rel);
    await fs.writeFile(absA, "v1\n", "utf8");
    await engineA.addFiles(wid, [absA]);

    // Machine B attaches and pulls v1
    const engineB = new SyncEngine({
      workspaceRoot: rootB,
      provider,
      machineId: "machine-b",
      machineName: "home",
    });
    await engineB.attachCloudWorkspace(wid);
    const absB = path.join(rootB, rel);
    await expect(fs.readFile(absB, "utf8")).resolves.toBe("v1\n");

    // Machine A edits and pushes v2, then claims a soft lock (still editing)
    await fs.writeFile(absA, "v2\n", "utf8");
    await engineA.pushAll(wid);
    await engineA.setSoftLock(wid, rel);

    // Auto-only pass on B (check-only) must surface cloud_newer + editingBy,
    // but NOT pull (auto only watches; user decides).
    await engineB.checkWorkspaceStatus(wid);
    const cfgB0 = await WorkspaceConfigManager.load(rootB);
    const fileB0 = cfgB0.files.find((f) => f.localPath === rel);
    expect(fileB0?.syncStatus).toBe("cloud_newer");
    expect(fileB0?.editingBy).toBe("machine-a");
    await expect(fs.readFile(absB, "utf8")).resolves.toBe("v1\n");

    // User decides: explicit Pull on machine B (this is what was rolling back).
    await engineB.pullAll(wid);
    await expect(fs.readFile(absB, "utf8")).resolves.toBe("v2\n");
    const cfgB1 = await WorkspaceConfigManager.load(rootB);
    const fileB1 = cfgB1.files.find((f) => f.localPath === rel);
    expect(fileB1?.syncStatus).toBe("ok");
    // Soft lock indication must remain (UI hint) but status is "ok"
    expect(fileB1?.editingBy).toBe("machine-a");

    // Regression: a follow-up check-only pass must NOT roll status back
    // to "cloud_newer" just because machine-a's soft lock is still active.
    await engineB.checkWorkspaceStatus(wid);
    const cfgB2 = await WorkspaceConfigManager.load(rootB);
    const fileB2 = cfgB2.files.find((f) => f.localPath === rel);
    expect(fileB2?.syncStatus).toBe("ok");
    expect(fileB2?.editingBy).toBe("machine-a");

    // Run it several more times — must remain stable, not oscillate.
    for (let i = 0; i < 5; i += 1) {
      await engineB.checkWorkspaceStatus(wid);
      const cfg = await WorkspaceConfigManager.load(rootB);
      const f = cfg.files.find((x) => x.localPath === rel);
      expect(f?.syncStatus, `iteration ${String(i)}`).toBe("ok");
    }
  });

  it("checkWorkspaceStatus right after pullFile does not flip 'ok' back to anything", async () => {
    const provider = new MockCloudProvider("onedrive");
    rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-roll2-a-"));
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-roll2-b-"));

    const engineA = new SyncEngine({
      workspaceRoot: rootA,
      provider,
      machineId: "machine-a",
      machineName: "A",
    });
    const wid = await engineA.createWorkspace("post-pull-stable", "onedrive");
    const rel = "doc.txt";
    const absA = path.join(rootA, rel);
    await fs.writeFile(absA, "alpha\n", "utf8");
    await engineA.addFiles(wid, [absA]);

    const engineB = new SyncEngine({
      workspaceRoot: rootB,
      provider,
      machineId: "machine-b",
      machineName: "B",
    });
    await engineB.attachCloudWorkspace(wid);

    // A pushes a new version
    await fs.writeFile(absA, "beta\n", "utf8");
    await engineA.pushAll(wid);

    // B pulls and then immediately check-only — must stay "ok"
    await engineB.pullAll(wid);
    const cfg1 = await WorkspaceConfigManager.load(rootB);
    expect(cfg1.files.find((f) => f.localPath === rel)?.syncStatus).toBe("ok");

    await engineB.checkWorkspaceStatus(wid);
    const cfg2 = await WorkspaceConfigManager.load(rootB);
    expect(cfg2.files.find((f) => f.localPath === rel)?.syncStatus).toBe("ok");
  });
});
