/**
 * Tests for:
 * - onPurgeLostFiles callback when files disappear from manifest (tombstone purged)
 * - adoptManifestFilesFromCloud detects renamedFrom and updates localPath (via syncWorkspace)
 * - onNewConflict callback fires when conflict is detected
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { SyncEngine } from "../../src/core/syncEngine.js";
import { WorkspaceConfigManager } from "../../src/core/workspaceConfigManager.js";
import { manifestCloudPath, metaCloudPath } from "../../src/core/cloudLayout.js";
import type { CloudManifest, MetaJson } from "../../src/core/cloudLayout.js";
import type { PurgeLostFileItem } from "../../src/core/syncEngine.js";
import { computeHash } from "../../src/utils/hash.js";

describe("onPurgeLostFiles callback", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots) {
      await fs.rm(r, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it("fires when tracked file disappears from manifest and still exists on disk", async () => {
    const provider = new MockCloudProvider("onedrive");
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-purge-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-purge-b-"));
    roots.push(rootA, rootB);

    // Setup
    const engineA = new SyncEngine({ workspaceRoot: rootA, provider, machineId: "A", machineName: "A", trigger: "user" });
    const wsId = await engineA.createWorkspace("purge-test", "onedrive");
    const absA = path.join(rootA, "watch.ts");
    await fs.writeFile(absA, "content", "utf8");
    await engineA.addFiles(wsId, [absA]);

    // B connects and syncs
    const lostItems: PurgeLostFileItem[] = [];
    const engineB = new SyncEngine({
      workspaceRoot: rootB,
      provider,
      machineId: "B",
      machineName: "B",
      trigger: "user",
      onPurgeLostFiles: (items) => { lostItems.push(...items); },
    });
    await engineB.attachCloudWorkspace(wsId);

    // Verify B tracked the file and it exists on disk
    const wcB = await WorkspaceConfigManager.load(rootB);
    expect(wcB.files.some((f) => f.localPath === "watch.ts")).toBe(true);
    const absB = path.join(rootB, "watch.ts");
    try { await fs.access(absB); } catch { await fs.writeFile(absB, "content", "utf8"); }

    // Simulate: manifest no longer has watch.ts (tombstone purged)
    const manifestData = await provider.downloadFile(manifestCloudPath(wsId));
    const manifest = JSON.parse(manifestData.body.toString()) as CloudManifest;
    const patched: CloudManifest = {
      ...manifest,
      files: manifest.files.filter((f) => f.path !== "watch.ts"),
    };
    await provider.uploadFile(manifestCloudPath(wsId), Buffer.from(JSON.stringify(patched)));

    // B syncs — file on disk but gone from manifest
    await engineB.syncWorkspace(wsId);

    // Callback should have fired
    expect(lostItems.length).toBeGreaterThanOrEqual(1);
    expect(lostItems.some((i) => i.relPath === "watch.ts")).toBe(true);
  });
});

describe("adoptManifestFilesFromCloud with renamedFrom via syncWorkspace", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots) {
      await fs.rm(r, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it("syncWorkspace реплеит renamedFrom: локальные байты остаются на месте, ключ переезжает (Link Bindings, этап 3)", async () => {
    const provider = new MockCloudProvider("onedrive");
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-rename-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-rename-b-"));
    roots.push(rootA, rootB);

    // Machine A: add file
    const engineA = new SyncEngine({ workspaceRoot: rootA, provider, machineId: "A", machineName: "A", trigger: "user" });
    const wsId = await engineA.createWorkspace("rename-test", "onedrive");
    const absOld = path.join(rootA, "old.ts");
    await fs.writeFile(absOld, "hello", "utf8");
    await engineA.addFiles(wsId, [absOld]);

    // Machine B connects (adopts old.ts)
    const engineB = new SyncEngine({ workspaceRoot: rootB, provider, machineId: "B", machineName: "B", trigger: "user" });
    await engineB.attachCloudWorkspace(wsId);

    const wcBBefore = await WorkspaceConfigManager.load(rootB);
    expect(wcBBefore.files.some((f) => f.localPath === "old.ts")).toBe(true);

    // Machine A renames the file
    const absNew = path.join(rootA, "new.ts");
    await fs.copyFile(absOld, absNew);
    await engineA.renameTrackedFile(wsId, absOld, absNew);

    // Machine B syncs — should adopt new.ts via renamedFrom detection
    await engineB.syncWorkspace(wsId);

    const wcBAfter = await WorkspaceConfigManager.load(rootB);
    // B pulled old.ts to disk at attach — a canonical rename must not move
    // bytes silently: the row keeps its placement and re-keys via binding.
    const row = wcBAfter.files.find((f) => f.localPath === "old.ts");
    expect(row?.manifestPath).toBe("new.ts");
    // No duplicate row appears under the canonical name.
    expect(wcBAfter.files.some((f) => f.localPath === "new.ts")).toBe(false);
    expect(wcBAfter.files.filter((f) => f.workspaceId === wsId)).toHaveLength(1);
  });
});

describe("onNewConflict callback", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots) {
      await fs.rm(r, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it("fires when 3-way conflict detected (base != local AND base != cloud)", async () => {
    const provider = new MockCloudProvider("onedrive");
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-cb-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-cb-b-"));
    roots.push(rootA, rootB);

    // A creates workspace and file
    const engineA = new SyncEngine({ workspaceRoot: rootA, provider, machineId: "A", machineName: "A", trigger: "user" });
    const wsId = await engineA.createWorkspace("cb-test", "onedrive");
    const rel = "conflict.ts";
    const absA = path.join(rootA, rel);
    await fs.writeFile(absA, "original\n", "utf8");
    await engineA.addFiles(wsId, [absA]);

    // B connects
    const conflictFired: string[] = [];
    const engineB = new SyncEngine({
      workspaceRoot: rootB,
      provider,
      machineId: "B",
      machineName: "B",
      trigger: "user",
      onNewConflict: (_ws, _note, relPath) => { conflictFired.push(relPath); },
    });
    await engineB.attachCloudWorkspace(wsId);

    // Write different content to B's local file
    const absB = path.join(rootB, rel);
    await fs.writeFile(absB, "B-version\n", "utf8");

    // Simulate: A already pushed a new version to cloud (update _meta with A's hash as the new base)
    // Use a stale hash on B's local config so: base = A-version, local = B-version, cloud = A-version
    // → detectChange: "base != local && cloud == base" → push. But we want conflict:
    // Simulate by setting B's localHash to stale hash (pre-original)
    const staleHash = await computeHash(absB, { lineEnding: "lf" });
    const wcB = await WorkspaceConfigManager.load(rootB);
    const fileEntry = wcB.files.find((f) => f.localPath === rel);
    if (fileEntry) {
      fileEntry.localHash = "stale-hash-xyz";
    }
    await WorkspaceConfigManager.save(wcB, rootB);

    // Also update cloud with A's version so cloud != B's local
    await fs.writeFile(absA, "A-version\n", "utf8");
    await engineA.syncWorkspace(wsId);

    // Now: base = hash("A-version") in _meta; localCurrent = hash("B-version"); cloudCurrent = hash("A-version")
    // Since base == cloudCurrent, detectChange says "push" not conflict
    // To make it a true conflict: patch _meta so that base != cloud too.
    // We must also clear the cached etag — otherwise the download path on B
    // sees ifNoneMatch hit and returns notModified, which makes cloudCurrent
    // collapse to base (= "fake-base-hash") and the 3-way conflict is masked.
    const metaDl = await provider.downloadFile(metaCloudPath(wsId));
    const meta = JSON.parse(metaDl.body.toString()) as MetaJson;
    if (meta.files[rel]) {
      meta.files[rel] = { ...meta.files[rel], hash: "fake-base-hash", etag: "" };
    }
    await provider.uploadFile(metaCloudPath(wsId), Buffer.from(JSON.stringify(meta)));

    // Now: base = "fake-base-hash", local = hash("B-version"), cloud = hash("A-version")
    // All three different → conflict
    await engineB.syncWorkspace(wsId);

    expect(conflictFired).toContain(rel);
    void staleHash;
  });
});
