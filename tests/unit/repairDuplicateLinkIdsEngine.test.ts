/**
 * Engine surface for the Health Check "repair duplicate linkIds" button:
 * `listDuplicateLinkIds` (read-only) + `repairWorkspaceDuplicateLinkIds`
 * (newest carrier keeps the identity, older ones tombstone, bindings fold).
 * The pure transform is covered in linkIdentity.test.ts — here we prove the
 * engine wiring: manifest fetch, mutation gate, PUT round-trip.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { SyncEngine } from "../../src/core/syncEngine.js";
import { manifestCloudPath, type CloudManifest } from "../../src/core/cloudLayout.js";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots) {
    await fs.rm(r, { recursive: true, force: true });
  }
  roots.length = 0;
});

async function setup(trigger: "user" | "auto" = "user") {
  const provider = new MockCloudProvider("onedrive");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-dupfix-"));
  roots.push(root);
  const engine = new SyncEngine({
    workspaceRoot: root,
    provider,
    machineId: "M1",
    machineName: "test",
    trigger,
  });
  const wsId = await engine.createWorkspace("dup-test", "onedrive");
  return { provider, root, engine, wsId };
}

async function cloudManifest(provider: MockCloudProvider, wsId: string): Promise<CloudManifest> {
  const dl = await provider.downloadFile(manifestCloudPath(wsId));
  return JSON.parse(dl.body.toString()) as CloudManifest;
}

/** Plant two live carriers of one linkId straight into the cloud manifest. */
async function plantDuplicate(provider: MockCloudProvider, wsId: string): Promise<void> {
  const m = await cloudManifest(provider, wsId);
  // M2 must exist in machines[] or the write-path hygiene prunes its binding.
  m.machines.push({ machineId: "M2", machineName: "other", lastSeen: new Date().toISOString() });
  m.files.push(
    {
      path: "old/name.ts",
      addedAt: "2026-08-01T00:00:00.000Z",
      version: 5,
      hasSyncignoreMarkers: false,
      linkId: "aaaaaaaaaaaaaaaa",
      bindings: { M2: { path: "their/name.ts", boundAt: "2026-08-01T00:00:00.000Z" } },
    },
    {
      path: "new/name.ts",
      addedAt: "2026-08-02T00:00:00.000Z",
      version: 6,
      hasSyncignoreMarkers: false,
      linkId: "aaaaaaaaaaaaaaaa",
    },
  );
  await provider.uploadFile(
    manifestCloudPath(wsId),
    Buffer.from(JSON.stringify(m, null, 2), "utf8"),
  );
}

describe("listDuplicateLinkIds / repairWorkspaceDuplicateLinkIds", () => {
  it("lists the planted duplicate group and repairs it: newest carrier survives, bindings fold", async () => {
    const { provider, engine, wsId } = await setup();
    await plantDuplicate(provider, wsId);

    const groups = await engine.listDuplicateLinkIds(wsId);
    expect(groups).toHaveLength(1);
    expect(groups[0].paths).toEqual(["old/name.ts", "new/name.ts"]);

    const repaired = await engine.repairWorkspaceDuplicateLinkIds(wsId);
    expect(repaired).toBe(1);

    const after = await cloudManifest(provider, wsId);
    const oldRow = after.files.find((f) => f.path === "old/name.ts");
    const newRow = after.files.find((f) => f.path === "new/name.ts");
    expect(oldRow?.removedAt).toBeTruthy();
    expect(newRow?.removedAt).toBeUndefined();
    // The loser's binding travels to the survivor.
    expect(newRow?.bindings?.M2.path).toBe("their/name.ts");
    // Nothing left to list or repair; the repair is idempotent.
    expect(await engine.listDuplicateLinkIds(wsId)).toEqual([]);
    expect(await engine.repairWorkspaceDuplicateLinkIds(wsId)).toBe(0);
  });

  it("refuses to repair from a non-user trigger (mutation policy)", async () => {
    const { provider, engine, wsId } = await setup();
    await plantDuplicate(provider, wsId);
    const auto = new SyncEngine({
      workspaceRoot: roots[roots.length - 1],
      provider,
      machineId: "M1",
      machineName: "test",
      trigger: "auto",
    });
    await expect(auto.repairWorkspaceDuplicateLinkIds(wsId)).rejects.toThrow();
    // The read-only listing stays available to any trigger.
    expect((await engine.listDuplicateLinkIds(wsId)).length).toBe(1);
  });
});
