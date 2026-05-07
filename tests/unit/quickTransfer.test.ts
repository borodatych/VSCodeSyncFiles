import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import {
  isQueuedQuickTransferSendExpired,
  listIncomingQuickTransfers,
  quickTransferMetaPath,
  receiveQuickTransferPackage,
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

      await receiveQuickTransferPackage(provider, only.transferId, rootB, "");
      await expect(fs.readFile(path.join(rootB, "note.txt"), "utf8")).resolves.toBe("hello-qt\n");

      const after = await listIncomingQuickTransfers(provider, "m-b");
      expect(after).toHaveLength(0);
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
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
