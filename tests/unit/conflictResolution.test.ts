/**
 * Tests for conflict resolution:
 *  - resolveConflictKeepMine / resolveConflictTakeTheirs (manual resolution)
 *  - tombstone purge on putManifest
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { SyncEngine } from "../../src/core/syncEngine.js";
import { WorkspaceConfigManager } from "../../src/core/workspaceConfigManager.js";
import { metaCloudPath, manifestCloudPath, trackedFileCloudPath } from "../../src/core/cloudLayout.js";
import type { MetaJson, CloudManifest } from "../../src/core/cloudLayout.js";
import { computeHash } from "../../src/utils/hash.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupBase() {
  const provider = new MockCloudProvider("onedrive");
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-conf-a-"));
  const engineA = new SyncEngine({ workspaceRoot: rootA, provider, machineId: "A", machineName: "A", trigger: "user" });
  const wid = await engineA.createWorkspace("conflict-test", "onedrive");
  const rel = "src/config.ts";
  const absA = path.join(rootA, "src", "config.ts");
  await fs.mkdir(path.dirname(absA), { recursive: true });
  await fs.writeFile(absA, "// base\n", "utf8");
  await engineA.addFiles(wid, [absA]);
  return { provider, rootA, engineA, wid, rel, absA };
}

/**
 * Seed a "stale" conflict state for machine B:
 * - cloud blob = contentCloud
 * - _meta.hash = staleHash (different from both local and cloud)
 * - B's local file = contentLocal
 * - B's vscodesync.json: localHash = staleHash (so neither matches base)
 */
async function seedConflictState(
  provider: MockCloudProvider,
  rootB: string,
  wid: string,
  rel: string,
  contentLocal: string,
  contentCloud: string,
  engineB: SyncEngine,
) {
  // First attach B so vscodesync.json is created
  await engineB.attachCloudWorkspace(wid);

  const absB = path.join(rootB, ...rel.split("/"));
  // Write local "mine" content
  await fs.writeFile(absB, contentLocal, "utf8");

  // Upload cloud blob with "cloud" content
  const cloudPath = trackedFileCloudPath(wid, rel);
  const cloudBuf = Buffer.from(contentCloud, "utf8");
  const uploadRes = await provider.uploadFile(cloudPath, cloudBuf);
  const blobEtag = uploadRes.etag;

  // Compute hashes for cloud and local (canonical: lf)
  const staleHash = "stale-baseline-hash-does-not-match-either";
  const cloudHash = await computeHash(absB, { lineEnding: "lf" }).catch(() => "");
  void cloudHash; // used below

  // Patch _meta.json on cloud: hash = staleHash (simulates race / stale meta)
  const metaPath = metaCloudPath(wid);
  const updatedAt = new Date().toISOString();
  const meta: MetaJson = {
    files: {
      [rel]: { hash: staleHash, etag: blobEtag ?? "", version: 99, machineId: "A", updatedAt },
    },
  };
  await provider.uploadFile(metaPath, Buffer.from(JSON.stringify(meta, null, 2) + "\n", "utf8"));

  // Patch B's vscodesync.json: localHash = staleHash (so base=stale, local≠stale, cloud≠stale → conflict)
  const cfg = await WorkspaceConfigManager.load(rootB);
  const fileEntry = cfg.files.find((f) => f.localPath === rel);
  if (fileEntry) {
    fileEntry.localHash = staleHash;
  }
  await WorkspaceConfigManager.save(cfg, rootB);
}

// ---------------------------------------------------------------------------
// resolveConflictKeepMine / resolveConflictTakeTheirs
// ---------------------------------------------------------------------------

describe("conflict resolution — resolveConflictKeepMine / resolveConflictTakeTheirs", () => {
  let rootA = "";
  let rootB = "";

  afterEach(async () => {
    for (const r of [rootA, rootB]) {
      if (r) await fs.rm(r, { recursive: true, force: true });
    }
    rootA = "";
    rootB = "";
  });

  it("resolveConflictKeepMine: pushes local content, clears conflict", async () => {
    const { provider, rootA: rA, wid, rel } = await setupBase();
    rootA = rA;
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-conf-b-"));

    const engineB = new SyncEngine({ workspaceRoot: rootB, provider, machineId: "B", machineName: "B", trigger: "user" });
    await seedConflictState(provider, rootB, wid, rel, "// version-B\n", "// version-A\n", engineB);

    // Trigger syncWorkspace so conflict is detected
    await engineB.syncWorkspace(wid);
    const cfgAfterSync = await WorkspaceConfigManager.load(rootB);
    expect(cfgAfterSync.files.find((f) => f.localPath === rel)?.syncStatus).toBe("conflict");

    // Keep mine
    await engineB.resolveConflictKeepMine(wid, rel);
    const cfgFinal = await WorkspaceConfigManager.load(rootB);
    expect(cfgFinal.files.find((f) => f.localPath === rel)?.syncStatus).not.toBe("conflict");

    // Cloud should now have B's content
    const cloudDl = await provider.downloadFile(trackedFileCloudPath(wid, rel));
    expect(cloudDl.body.toString("utf8")).toBe("// version-B\n");
  });

  it("resolveConflictKeepMine: облако ушло вперёд после отметки конфликта → cloud_moved без записи", async () => {
    const { provider, rootA: rA, engineA, wid, rel, absA } = await setupBase();
    rootA = rA;
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-conf-b-"));

    const engineB = new SyncEngine({ workspaceRoot: rootB, provider, machineId: "B", machineName: "B", trigger: "user" });
    await seedConflictState(provider, rootB, wid, rel, "// version-B\n", "// version-A\n", engineB);
    await engineB.syncWorkspace(wid);
    expect(
      (await WorkspaceConfigManager.load(rootB)).files.find((f) => f.localPath === rel)?.syncStatus,
    ).toBe("conflict");

    // Machine A pushes a third version the user of B has never seen.
    const cloudPath = trackedFileCloudPath(wid, rel);
    await fs.writeFile(absA, "// version-C\n", "utf8");
    // The seeded stale `_meta` makes A see a conflict too; A resolves it in
    // favour of its own version, which is exactly the "cloud moved" case for B.
    await engineA.pushAll(wid);
    await engineA.resolveConflictKeepMine(wid, rel, { force: true });
    expect((await provider.downloadFile(cloudPath)).body.toString("utf8")).toBe("// version-C\n");

    expect(await engineB.resolveConflictKeepMine(wid, rel)).toBe("cloud_moved");
    expect((await provider.downloadFile(cloudPath)).body.toString("utf8")).toBe("// version-C\n");
    expect(
      (await WorkspaceConfigManager.load(rootB)).files.find((f) => f.localPath === rel)?.syncStatus,
    ).toBe("conflict");

    // force: the user was told and chose their own version anyway.
    expect(await engineB.resolveConflictKeepMine(wid, rel, { force: true })).toBe("pushed");
    expect((await provider.downloadFile(cloudPath)).body.toString("utf8")).toBe("// version-B\n");
  });

  it("resolveConflictTakeTheirs: pulls cloud content, clears conflict", async () => {
    const { provider, rootA: rA, wid, rel } = await setupBase();
    rootA = rA;
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-conf-b-"));

    const engineB = new SyncEngine({ workspaceRoot: rootB, provider, machineId: "B", machineName: "B", trigger: "user" });
    await seedConflictState(provider, rootB, wid, rel, "// version-B\n", "// version-A\n", engineB);

    await engineB.syncWorkspace(wid);
    const cfgAfterSync = await WorkspaceConfigManager.load(rootB);
    expect(cfgAfterSync.files.find((f) => f.localPath === rel)?.syncStatus).toBe("conflict");

    // Take theirs
    await engineB.resolveConflictTakeTheirs(wid, rel);
    const cfgFinal = await WorkspaceConfigManager.load(rootB);
    expect(cfgFinal.files.find((f) => f.localPath === rel)?.syncStatus).not.toBe("conflict");

    // B's local file should have cloud content
    const absB = path.join(rootB, ...rel.split("/"));
    expect(await fs.readFile(absB, "utf8")).toBe("// version-A\n");
  });
});


// ---------------------------------------------------------------------------
// Tombstone purge
// ---------------------------------------------------------------------------

describe("tombstone purge", () => {
  let rootA = "";

  afterEach(async () => {
    if (rootA) await fs.rm(rootA, { recursive: true, force: true });
    rootA = "";
  });

  it("removedAt older than purgeDays is dropped from manifest on next putManifest", async () => {
    const provider = new MockCloudProvider("onedrive");
    rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-tomb-"));
    const engine = new SyncEngine({
      workspaceRoot: rootA,
      provider,
      machineId: "A",
      machineName: "A",
      trigger: "user",
      tombstonePurgeDays: 1,
    });

    const wid = await engine.createWorkspace("tomb-test", "onedrive");
    const rel = "old.ts";
    const abs = path.join(rootA, rel);
    await fs.writeFile(abs, "x\n", "utf8");
    await engine.addFiles(wid, [abs]);
    await engine.removeTrackedFiles(wid, [abs]);

    // Manually patch removedAt to 2 days ago on cloud manifest
    const mPath = manifestCloudPath(wid);
    const stored = provider.files.get(mPath);
    if (!stored) throw new Error("manifest not found in mock");
    const manifest = JSON.parse(stored.content.toString("utf8")) as CloudManifest;
    const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    manifest.files = manifest.files.map((f) =>
      f.path === rel ? { ...f, removedAt: pastDate } : f,
    );
    await provider.uploadFile(mPath, Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));

    // Any putManifest call should purge the old tombstone
    await engine.renameWorkspaceNote(wid, "tomb-test-renamed");

    // Verify tombstone was purged
    const freshStored = provider.files.get(mPath);
    if (!freshStored) throw new Error("manifest not found after rename");
    const freshManifest = JSON.parse(freshStored.content.toString("utf8")) as CloudManifest;
    expect(freshManifest.files.some((f) => f.path === rel)).toBe(false);
  });

  it("recent removedAt (within purgeDays) is retained", async () => {
    const provider = new MockCloudProvider("onedrive");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-tomb2-"));
    const engine = new SyncEngine({
      workspaceRoot: root,
      provider,
      machineId: "A",
      machineName: "A",
      trigger: "user",
      tombstonePurgeDays: 30,
    });

    const wid = await engine.createWorkspace("tomb-test2", "onedrive");
    const rel = "recent.ts";
    const abs = path.join(root, rel);
    await fs.writeFile(abs, "x\n", "utf8");
    await engine.addFiles(wid, [abs]);
    await engine.removeTrackedFiles(wid, [abs]);

    // removedAt is now (< 30 days) — should NOT be purged
    await engine.renameWorkspaceNote(wid, "tomb-test2-renamed");

    const freshStored = provider.files.get(manifestCloudPath(wid));
    if (!freshStored) throw new Error("manifest not found");
    const freshManifest = JSON.parse(freshStored.content.toString("utf8")) as CloudManifest;
    // tombstone should still be there (not yet old enough)
    expect(freshManifest.files.some((f) => f.path === rel && f.removedAt)).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
  });
});
