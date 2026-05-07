import { describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";
import {
  copyVsCodeSyncFilesToPreMigrationSnapshot,
  copyVsCodeSyncTreeBetweenProviders,
  deleteVsCodeSyncRootOnProvider,
  isPreMigrationArchivePath,
  listExportableVsCodeSyncFiles,
  patchManifestProviderTypesOnProvider,
  preMigrationSnapshotFolderBasename,
} from "../../src/core/cloudMigration.js";
import { manifestCloudPath, SUPPORTED_MANIFEST_SCHEMA } from "../../src/core/cloudLayout.js";

describe("cloudMigration", () => {
  it("isPreMigrationArchivePath", () => {
    expect(isPreMigrationArchivePath("VSCodeSyncFiles/.snapshots/pre-migration-2026/a.txt")).toBe(true);
    expect(isPreMigrationArchivePath("VSCodeSyncFiles/ws/.snapshots/user/a.txt")).toBe(false);
    expect(isPreMigrationArchivePath("VSCodeSyncFiles/ws/file.txt")).toBe(false);
  });

  it("preMigrationSnapshotFolderBasename contains pre-migration prefix", () => {
    expect(preMigrationSnapshotFolderBasename()).toMatch(/^pre-migration-/);
  });

  it("copyVsCodeSyncTreeBetweenProviders copies files excluding pre-migration archives", async () => {
    const a = new MockCloudProvider("onedrive");
    const b = new MockCloudProvider("gdrive");
    await a.uploadFile("VSCodeSyncFiles/w81/readme.txt", Buffer.from("x"));
    await a.uploadFile("VSCodeSyncFiles/.snapshots/pre-migration-old/w81/x.txt", Buffer.from("old"));
    const n = await copyVsCodeSyncTreeBetweenProviders(a, b);
    expect(n).toBe(1);
    const dl = await b.downloadFile("VSCodeSyncFiles/w81/readme.txt");
    expect(dl.body.toString()).toBe("x");
    await expect(b.downloadFile("VSCodeSyncFiles/.snapshots/pre-migration-old/w81/x.txt")).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("copyVsCodeSyncFilesToPreMigrationSnapshot mirrors tree", async () => {
    const a = new MockCloudProvider("onedrive");
    await a.uploadFile("VSCodeSyncFiles/ws/a.txt", Buffer.from("a"));
    const name = "pre-migration-testcase";
    await copyVsCodeSyncFilesToPreMigrationSnapshot(a, name);
    const dl = await a.downloadFile(`VSCodeSyncFiles/.snapshots/${name}/ws/a.txt`);
    expect(dl.body.toString()).toBe("a");
  });

  it("patchManifestProviderTypesOnDest updates manifests", async () => {
    const p = new MockCloudProvider("gdrive");
    const man = {
      schemaVersion: SUPPORTED_MANIFEST_SCHEMA,
      workspaceId: "abc",
      workspaceNote: "n",
      tags: [],
      sharedIgnorePatterns: [],
      providerType: "onedrive" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      machines: [],
      files: [],
    };
    await p.uploadFile(manifestCloudPath("abc"), Buffer.from(`${JSON.stringify(man, null, 2)}\n`));
    await patchManifestProviderTypesOnProvider(p, "gdrive");
    const raw = JSON.parse((await p.downloadFile(manifestCloudPath("abc"))).body.toString("utf8")) as {
      providerType: string;
    };
    expect(raw.providerType).toBe("gdrive");
  });

  it("deleteVsCodeSyncRootOnProvider removes entire VSCodeSyncFiles tree", async () => {
    const a = new MockCloudProvider("onedrive");
    await a.uploadFile("VSCodeSyncFiles/w81/a.txt", Buffer.from("x"));
    await a.uploadFile("VSCodeSyncFiles/.snapshots/pre-migration-old/z.txt", Buffer.from("z"));
    await deleteVsCodeSyncRootOnProvider(a);
    expect(a.files.size).toBe(0);
  });

  it("listExportableVsCodeSyncFiles skips pre-migration paths", async () => {
    const a = new MockCloudProvider("onedrive");
    await a.uploadFile("VSCodeSyncFiles/ok.txt", Buffer.from("1"));
    await a.uploadFile("VSCodeSyncFiles/.snapshots/pre-migration-x/y.txt", Buffer.from("2"));
    const paths = await listExportableVsCodeSyncFiles(a);
    expect(paths.sort()).toEqual(["VSCodeSyncFiles/ok.txt"]);
  });
});
