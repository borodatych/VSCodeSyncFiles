import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runWithSyncFileLock, subscribeSyncFileLock, syncFileLockKey } from "../../src/core/syncFileLock.js";

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
    const log: string[] = [];
    const p1 = runWithSyncFileLock("/r", "z.ts", "push", () => {
      log.push("fail");
      return Promise.reject(new Error("x"));
    }).catch(() => {
      log.push("caught");
    });
    const p2 = runWithSyncFileLock("/r", "z.ts", "push", () => {
      log.push("after");
      return Promise.resolve(0);
    });
    await p1;
    await p2;
    expect(log).toEqual(["fail", "after", "caught"]);
  });
});
