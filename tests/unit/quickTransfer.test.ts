import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import {
  applyQuickTransferReceive,
  isQueuedQuickTransferSendExpired,
  listIncomingQuickTransfers,
  prepareQuickTransferReceive,
  quickTransferMetaPath,
  quickTransferSideBySidePath,
  sendQuickTransferFile,
} from "../../src/core/quickTransfer.js";

describe("QuickTransfer", () => {
  it("offline queue TTL: not expired on boundary, expired right after", () => {
    const queuedAt = "2026-04-01T00:00:00.000Z";
    const boundary = Date.parse("2026-04-08T00:00:00.000Z");
    expect(isQueuedQuickTransferSendExpired(queuedAt, 7, boundary)).toBe(false);
    expect(isQueuedQuickTransferSendExpired(queuedAt, 7, boundary + 1)).toBe(true);
  });

  it("отправка → входящие на другой machineId → получение в другой корень", async () => {
    const provider = new MockCloudProvider("onedrive");
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-qt-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-qt-b-"));
    try {
      const fp = path.join(rootA, "note.txt");
      await fs.writeFile(fp, "hello-qt\n", "utf8");
      await sendQuickTransferFile(provider, {
        machineId: "m-a",
        machineName: "home",
        ttlDays: 7,
        absolutePath: fp,
        projectRelativePosix: "note.txt",
      });

      const incoming = await listIncomingQuickTransfers(provider, "m-b");
      expect(incoming).toHaveLength(1);
      const only = incoming[0];
      expect(only.transferId.length).toBeGreaterThan(0);
      expect(only.meta.fromMachineName).toBe("home");

      const prepared = await prepareQuickTransferReceive(provider, only.transferId, rootB, "");
      expect(prepared.destExists).toBe(false);
      await applyQuickTransferReceive(provider, prepared, "overwrite", { workspaceRoot: rootB });
      await expect(fs.readFile(path.join(rootB, "note.txt"), "utf8")).resolves.toBe("hello-qt\n");

      const after = await listIncomingQuickTransfers(provider, "m-b");
      expect(after).toHaveLength(0);
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it("существующий файл: destExists=true, режим side-by-side не трогает оригинал", async () => {
    const provider = new MockCloudProvider("onedrive");
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-qt-sa-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-qt-sb-"));
    try {
      await fs.writeFile(path.join(rootA, "note.txt"), "incoming\n", "utf8");
      await fs.writeFile(path.join(rootB, "note.txt"), "mine\n", "utf8");
      await sendQuickTransferFile(provider, {
        machineId: "m-a",
        machineName: "a",
        ttlDays: 7,
        absolutePath: path.join(rootA, "note.txt"),
        projectRelativePosix: "note.txt",
      });
      const [only] = await listIncomingQuickTransfers(provider, "m-b");
      const prepared = await prepareQuickTransferReceive(provider, only.transferId, rootB, "");
      expect(prepared.destExists).toBe(true);

      const r = await applyQuickTransferReceive(provider, prepared, "side-by-side", {
        workspaceRoot: rootB,
      });
      await expect(fs.readFile(path.join(rootB, "note.txt"), "utf8")).resolves.toBe("mine\n");
      await expect(fs.readFile(path.join(rootB, r.savedTo), "utf8")).resolves.toBe("incoming\n");
      expect(r.savedTo).toMatch(/^note\.incoming-.*\.txt$/);
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it("перезапись с бэкапом: старое содержимое остаётся в localBackupDir", async () => {
    const provider = new MockCloudProvider("onedrive");
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-qt-ba-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-qt-bb-"));
    try {
      await fs.writeFile(path.join(rootA, "note.txt"), "incoming\n", "utf8");
      await fs.writeFile(path.join(rootB, "note.txt"), "mine\n", "utf8");
      await sendQuickTransferFile(provider, {
        machineId: "m-a",
        machineName: "a",
        ttlDays: 7,
        absolutePath: path.join(rootA, "note.txt"),
        projectRelativePosix: "note.txt",
      });
      const [only] = await listIncomingQuickTransfers(provider, "m-b");
      const prepared = await prepareQuickTransferReceive(provider, only.transferId, rootB, "");
      await applyQuickTransferReceive(provider, prepared, "overwrite", {
        workspaceRoot: rootB,
        backup: { retentionDays: 7, backupDir: ".backup" },
      });
      await expect(fs.readFile(path.join(rootB, "note.txt"), "utf8")).resolves.toBe("incoming\n");
      const stamps = await fs.readdir(path.join(rootB, ".backup"));
      expect(stamps).toHaveLength(1);
      await expect(
        fs.readFile(path.join(rootB, ".backup", stamps[0], "note.txt"), "utf8"),
      ).resolves.toBe("mine\n");
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  });

  it("side-by-side имя: метка времени перед расширением", () => {
    const p = quickTransferSideBySidePath("/w/a/note.txt", Date.parse("2026-08-06T10:20:30.000Z"));
    expect(p).toBe("/w/a/note.incoming-2026-08-06T10-20-30Z.txt");
    expect(quickTransferSideBySidePath("/w/a/LICENSE", Date.parse("2026-08-06T10:20:30.000Z"))).toBe(
      "/w/a/LICENSE.incoming-2026-08-06T10-20-30Z",
    );
  });

  it("не показывать входящие с чужим targetMachineId", async () => {
    const provider = new MockCloudProvider("onedrive");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-qt-t-"));
    try {
      const fp = path.join(root, "x.txt");
      await fs.writeFile(fp, "x\n", "utf8");
      await sendQuickTransferFile(provider, {
        machineId: "m-a",
        machineName: "a",
        ttlDays: 7,
        absolutePath: fp,
        projectRelativePosix: "x.txt",
        targetMachineId: "only-z",
      });
      const incoming = await listIncomingQuickTransfers(provider, "m-b");
      expect(incoming).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("истёкший пакет удаляется при list", async () => {
    const provider = new MockCloudProvider("onedrive");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-qt-e-"));
    try {
      const fp = path.join(root, "old.txt");
      await fs.writeFile(fp, "o\n", "utf8");
      const { transferId } = await sendQuickTransferFile(provider, {
        machineId: "m-a",
        machineName: "a",
        ttlDays: 7,
        absolutePath: fp,
        projectRelativePosix: "old.txt",
      });
      const stale = {
        schemaVersion: 1,
        transferId,
        fromMachineId: "m-a",
        fromMachineName: "a",
        sentAt: new Date(0).toISOString(),
        relativePath: "old.txt",
        ttlDays: 1,
      };
      await provider.uploadFile(
        quickTransferMetaPath(transferId),
        Buffer.from(`${JSON.stringify(stale)}\n`, "utf8"),
      );
      const incoming = await listIncomingQuickTransfers(provider, "m-b");
      expect(incoming).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
