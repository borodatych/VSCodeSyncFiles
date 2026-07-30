/**
 * Tests for file tracking management:
 * - untrackFileLocal: removes from local config only
 * - untrackFileTombstoneOnly: tombstone in manifest, no blob deletion
 * - renameTrackedFile: updates localPath/cloudPath, copies blob, updates manifest
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { SyncEngine } from "../../src/core/syncEngine.js";
import { WorkspaceConfigManager } from "../../src/core/workspaceConfigManager.js";
import { manifestCloudPath, trackedFileCloudPath } from "../../src/core/cloudLayout.js";
import type { CloudManifest } from "../../src/core/cloudLayout.js";

async function setupBase() {
  const provider = new MockCloudProvider("onedrive");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-track-"));
  const engine = new SyncEngine({ workspaceRoot: root, provider, machineId: "M1", machineName: "test", trigger: "user" });
  const wsId = await engine.createWorkspace("track-test", "onedrive");
  return { provider, root, engine, wsId };
}

async function addFileToWorkspace(root: string, engine: SyncEngine, wsId: string, relPath: string, content: string) {
  const abs = path.join(root, ...relPath.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  await engine.addFiles(wsId, [abs]);
  return abs;
}

describe("untrackFileLocal", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots) {
      await fs.rm(r, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it("removes file from local vscodesync.json without touching cloud", async () => {
    const { provider, root, engine, wsId } = await setupBase();
    roots.push(root);
    const abs = await addFileToWorkspace(root, engine, wsId, "a.ts", "content");

    // Verify tracked
    const wcBefore = await WorkspaceConfigManager.load(root);
    expect(wcBefore.files.some((f) => f.localPath === "a.ts")).toBe(true);

    // Cloud blob should exist
    const cloudPath = trackedFileCloudPath(wsId, "a.ts");
    const blobBefore = await provider.downloadFile(cloudPath);
    expect(blobBefore.body.length).toBeGreaterThan(0);

    await engine.untrackFileLocal(wsId, [abs]);

    // Removed from local config
    const wcAfter = await WorkspaceConfigManager.load(root);
    expect(wcAfter.files.some((f) => f.localPath === "a.ts")).toBe(false);

    // Cloud blob still exists
    const blobAfter = await provider.downloadFile(cloudPath);
    expect(blobAfter.body.length).toBeGreaterThan(0);

    // Manifest still has the file (no tombstone)
    const manifestData = await provider.downloadFile(manifestCloudPath(wsId));
    const manifest = JSON.parse(manifestData.body.toString()) as CloudManifest;
    const mf = manifest.files.find((f) => f.path === "a.ts");
    expect(mf?.removedAt).toBeUndefined();
  });
});

describe("untrackFileTombstoneOnly", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots) {
      await fs.rm(r, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it("sets tombstone in manifest without deleting blob", async () => {
    const { provider, root, engine, wsId } = await setupBase();
    roots.push(root);
    const abs = await addFileToWorkspace(root, engine, wsId, "b.ts", "data");

    const cloudPath = trackedFileCloudPath(wsId, "b.ts");

    await engine.untrackFileTombstoneOnly(wsId, [abs]);

    // Removed from local config
    const wc = await WorkspaceConfigManager.load(root);
    expect(wc.files.some((f) => f.localPath === "b.ts")).toBe(false);

    // Cloud blob still exists (not deleted)
    const blob = await provider.downloadFile(cloudPath);
    expect(blob.body.length).toBeGreaterThan(0);

    // Manifest has tombstone
    const manifestData = await provider.downloadFile(manifestCloudPath(wsId));
    const manifest = JSON.parse(manifestData.body.toString()) as CloudManifest;
    const mf = manifest.files.find((f) => f.path === "b.ts");
    expect(mf?.removedAt).toBeTruthy();
  });
});

describe("renameTrackedFile", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots) {
      await fs.rm(r, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it("updates localPath, cloudPath and sets renamedFrom in manifest", async () => {
    const { provider, root, engine, wsId } = await setupBase();
    roots.push(root);
    const absOld = await addFileToWorkspace(root, engine, wsId, "old.ts", "content");
    const absNew = path.join(root, "new.ts");
    // Simulate rename by copying (in real VSCode, onDidRenameFiles fires)
    await fs.copyFile(absOld, absNew);

    await engine.renameTrackedFile(wsId, absOld, absNew);

    // Local config updated
    const wc = await WorkspaceConfigManager.load(root);
    expect(wc.files.some((f) => f.localPath === "new.ts")).toBe(true);
    expect(wc.files.some((f) => f.localPath === "old.ts")).toBe(false);

    // New cloud blob exists
    const newCloudPath = trackedFileCloudPath(wsId, "new.ts");
    const newBlob = await provider.downloadFile(newCloudPath);
    expect(newBlob.body.length).toBeGreaterThan(0);

    // Manifest: old entry has tombstone, new entry has renamedFrom
    const manifestData = await provider.downloadFile(manifestCloudPath(wsId));
    const manifest = JSON.parse(manifestData.body.toString()) as CloudManifest;
    const oldMf = manifest.files.find((f) => f.path === "old.ts");
    expect(oldMf?.removedAt).toBeTruthy();
    const newMf = manifest.files.find((f) => f.path === "new.ts");
    expect(newMf?.renamedFrom).toBe("old.ts");
    expect(newMf?.renamedAt).toBeTruthy();
  });

  it("is a no-op when old path = new path", async () => {
    const { root, engine, wsId } = await setupBase();
    roots.push(root);
    const abs = await addFileToWorkspace(root, engine, wsId, "same.ts", "x");

    const wcBefore = await WorkspaceConfigManager.load(root);
    await engine.renameTrackedFile(wsId, abs, abs);
    const wcAfter = await WorkspaceConfigManager.load(root);
    expect(wcAfter.files).toEqual(wcBefore.files);
  });
});
