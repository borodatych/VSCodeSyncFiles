import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SyncOfflineQueueStore } from "../../src/core/syncOfflineQueueStore.js";

describe("SyncOfflineQueueStore", () => {
  let dir: string;
  let store: SyncOfflineQueueStore;

  afterEach(async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("persists push/pull and replaces queue with fullSync", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-offq-"));
    store = new SyncOfflineQueueStore(dir);
    await store.enqueuePush("D:\\a", "x.txt", "ws1");
    await store.enqueuePull("D:\\a", "y.txt", "ws1");
    expect(await store.totalPending()).toBe(2);

    await store.enqueueFullSync();
    expect(await store.totalPending()).toBe(1);

    const snap = await store.drainSnapshot();
    expect(snap).toEqual([{ kind: "fullSync" }]);
    expect(await store.totalPending()).toBe(0);
  });

  it("dedupes file ops by root/rel/workspaceId keeping the latest kind", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-offq-"));
    store = new SyncOfflineQueueStore(dir);
    await store.enqueuePush("D:\\a", "f.txt", "ws1");
    await store.enqueuePull("D:\\a", "f.txt", "ws1");
    const snap = await store.drainSnapshot();
    expect(snap).toEqual([{ kind: "pull", root: "D:\\a", rel: "f.txt", workspaceId: "ws1" }]);
  });

  it("normalizes path case for dedupe key (case-insensitive roots)", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-offq-"));
    store = new SyncOfflineQueueStore(dir);
    await store.enqueuePush("D:/Proj", "x.txt", "ws");
    await store.enqueuePull("d:/proj", "x.txt", "ws");
    const snap = await store.drainSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ kind: "pull", rel: "x.txt" });
  });

  it("prependItems restores order before existing items", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-offq-"));
    store = new SyncOfflineQueueStore(dir);
    await store.enqueuePush("r", "a.txt", "w");
    await store.prependItems([{ kind: "pull", root: "r", rel: "b.txt", workspaceId: "w" }]);
    const snap = await store.drainSnapshot();
    expect(snap[0]).toMatchObject({ kind: "pull", rel: "b.txt" });
    expect(snap[1]).toMatchObject({ kind: "push", rel: "a.txt" });
  });

  it("preserves Quick Transfer when enqueueing fullSync", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-offq-"));
    store = new SyncOfflineQueueStore(dir);
    await store.enqueueQuickTransferSend({
      queuedAtIso: "2026-01-01T00:00:00.000Z",
      ttlDays: 7,
      absolutePath: "D:\\a\\f.txt",
      projectRelativePosix: "f.txt",
    });
    await store.enqueueFullSync();
    expect(await store.totalPending()).toBe(2);
    const snap = await store.drainSnapshot();
    expect(snap[0]).toEqual({ kind: "fullSync" });
    expect(snap[1]).toMatchObject({ kind: "quickTransferSend", projectRelativePosix: "f.txt" });
  });

  it("dedupes Quick Transfer by normalized absolute path", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-offq-"));
    store = new SyncOfflineQueueStore(dir);
    await store.enqueueQuickTransferSend({
      queuedAtIso: "2026-01-01T00:00:00.000Z",
      ttlDays: 7,
      absolutePath: "D:/a/x.txt",
      projectRelativePosix: "x.txt",
    });
    await store.enqueueQuickTransferSend({
      queuedAtIso: "2026-01-02T00:00:00.000Z",
      ttlDays: 3,
      absolutePath: "d:\\a\\x.txt",
      projectRelativePosix: "x.txt",
    });
    const snap = await store.drainSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ kind: "quickTransferSend", ttlDays: 3, queuedAtIso: "2026-01-02T00:00:00.000Z" });
  });
});
