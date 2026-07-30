import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runWithSyncFileLock,
  snapshotSyncFileLocks,
  subscribeSyncFileLock,
  syncFileLockKey,
  syncFileLockTailCount,
  SyncFileLockTimeoutError,
} from "../../src/core/syncFileLock.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("syncFileLock", () => {
  it("syncFileLockKey normalizes case and separators", () => {
    expect(syncFileLockKey("D:\\Proj", "src/Foo.ts")).toBe(syncFileLockKey("d:/proj", "src/foo.ts"));
  });

  it("serializes concurrent pull and push on same path (FIFO)", async () => {
    const log: string[] = [];
    const root = path.join("C:", "w");

    const a = runWithSyncFileLock(root, "a/b.ts", "pull", async () => {
      log.push("pull-a");
      await delay(15);
      log.push("pull-b");
      return 1;
    });
    const b = runWithSyncFileLock(root, "a/b.ts", "push", async () => {
      log.push("push-a");
      await delay(5);
      log.push("push-b");
      return 2;
    });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(1);
    expect(rb).toBe(2);
    expect(log).toEqual(["pull-a", "pull-b", "push-a", "push-b"]);
  });

  it("independent paths run in parallel", async () => {
    const log: string[] = [];
    const root = path.join("C:", "w");
    const t0 = Date.now();

    await Promise.all([
      runWithSyncFileLock(root, "x.ts", "pull", async () => {
        log.push("x");
        await delay(25);
        return 0;
      }),
      runWithSyncFileLock(root, "y.ts", "pull", async () => {
        log.push("y");
        await delay(25);
        return 0;
      }),
    ]);

    expect(log.sort()).toEqual(["x", "y"]);
    expect(Date.now() - t0).toBeLessThan(55);
  });

  it("enter/leave notifies subscribers", async () => {
    const ev: string[] = [];
    const unsub = subscribeSyncFileLock((e) => {
      ev.push(`${e.type}:${e.op}`);
    });
    await runWithSyncFileLock("/r", "f.ts", "pull", () => {
      ev.push("work");
      return Promise.resolve();
    });
    unsub();
    expect(ev).toEqual(["enter:pull", "work", "leave:pull"]);
  });

  it("continues chain when fn throws", async () => {
    // Contract: a rejected body must not wedge the key, and the next body must
    // start only after the previous one has fully settled. The exact microtask
    // interleaving between the first caller's `.catch` and the second body is
    // not part of that contract, so it is not asserted.
    const log: string[] = [];
    let firstBodyDone = false;
    const p1 = runWithSyncFileLock("/r", "z.ts", "push", () => {
      log.push("fail");
      firstBodyDone = true;
      return Promise.reject(new Error("x"));
    }).catch(() => {
      log.push("caught");
    });
    const p2 = runWithSyncFileLock("/r", "z.ts", "push", () => {
      expect(firstBodyDone).toBe(true);
      log.push("after");
      return Promise.resolve(0);
    });
    await p1;
    await p2;
    expect(log).toContain("fail");
    expect(log).toContain("after");
    expect(log).toContain("caught");
    expect(log.indexOf("fail")).toBeLessThan(log.indexOf("after"));
  });

  it("ожидание блокировки ограничено дедлайном", async () => {
    // Before the fix, waiting was unbounded: a body that never settled kept
    // every later operation on that file queued in silence forever.
    let releaseStuck: (() => void) | undefined;
    const stuck = runWithSyncFileLock("/r", "wait.ts", "push", () =>
      new Promise<void>((resolve) => {
        releaseStuck = resolve;
      }),
    );
    const waiter = runWithSyncFileLock(
      "/r",
      "wait.ts",
      "pull",
      () => Promise.resolve("never runs"),
      { waitTimeoutMs: 30 },
    );
    await expect(waiter).rejects.toBeInstanceOf(SyncFileLockTimeoutError);
    await expect(waiter).rejects.toMatchObject({ kind: "wait" });
    releaseStuck?.();
    await stuck;
  });

  it("зависшее тело отклоняет вызывающего, но ключ остаётся занятым", async () => {
    // Releasing the key on a hold timeout would let a second push start against
    // a file the first push may still be writing. A stuck key is the cheaper
    // failure, so the caller is rejected while the key stays blocked.
    let releaseStuck: (() => void) | undefined;
    const stuck = runWithSyncFileLock(
      "/r",
      "hold.ts",
      "push",
      () =>
        new Promise<void>((resolve) => {
          releaseStuck = resolve;
        }),
      { holdTimeoutMs: 30 },
    );
    await expect(stuck).rejects.toMatchObject({ kind: "hold" });

    let secondStarted = false;
    const second = runWithSyncFileLock(
      "/r",
      "hold.ts",
      "pull",
      () => {
        secondStarted = true;
        return Promise.resolve("ok");
      },
      { waitTimeoutMs: 1000 },
    );
    expect(secondStarted).toBe(false);
    releaseStuck?.();
    await expect(second).resolves.toBe("ok");
  });

  it("карта хвостов не растёт: ключ удаляется, когда его никто не ждёт", async () => {
    const before = syncFileLockTailCount();
    await runWithSyncFileLock("/r", "tail-a.ts", "push", () => Promise.resolve(1));
    await runWithSyncFileLock("/r", "tail-b.ts", "push", () => Promise.resolve(2));
    expect(syncFileLockTailCount()).toBe(before);
  });

  it("удерживаемые локи видны в снимке", async () => {
    let release: (() => void) | undefined;
    const held = runWithSyncFileLock("/r", "snap.ts", "pull", () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    // The body starts one turn later than the call: acquiring the lock now
    // awaits its (bounded) turn first.
    await delay(0);
    const snap = snapshotSyncFileLocks();
    expect(snap.some((s) => s.key.endsWith("snap.ts") && s.op === "pull")).toBe(true);
    release?.();
    await held;
    expect(snapshotSyncFileLocks().some((s) => s.key.endsWith("snap.ts"))).toBe(false);
  });
});
