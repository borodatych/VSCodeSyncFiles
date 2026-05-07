import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hashWorkspaceRoots,
  scheduleWorkspaceInstanceLockRefresh,
  disposeWorkspaceInstanceLock,
} from "../../src/core/workspaceInstanceLock.js";
import { isSecondaryWorkspaceInstanceReadOnly } from "../../src/core/syncWorkspaceInstanceReadOnly.js";

describe("workspaceInstanceLock", () => {
  it("hashWorkspaceRoots is order-insensitive and case-normalized on Windows-style paths", () => {
    const a = hashWorkspaceRoots(["C:\\Proj\\A", "D:/Proj/B"]);
    const b = hashWorkspaceRoots(["d:/proj/b", "c:\\proj\\a"]);
    expect(a).toBe(b);
    expect(a.length).toBe(64);
  });

  it("replaces stale lock when holder PID is dead", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscodesync-lock-"));
    try {
      await disposeWorkspaceInstanceLock();
      const roots = [path.join(dir, "w")];

      await new Promise<void>((resolve) => {
        scheduleWorkspaceInstanceLockRefresh(dir, roots, () => resolve());
      });
      expect(isSecondaryWorkspaceInstanceReadOnly()).toBe(false);
      const h = hashWorkspaceRoots(roots);
      const lockPath = path.join(dir, `${h}.lock`);
      const raw = await fs.readFile(lockPath, "utf8");
      const body = JSON.parse(raw) as { pid: number; nonce: string; lockedAt: string };
      expect(typeof body.pid).toBe("number");
      expect(typeof body.nonce).toBe("string");
      expect(body.nonce.length).toBeGreaterThan(10);

      const deadPid = 1999999999;
      const foreign = { pid: deadPid, nonce: "foreign", lockedAt: new Date().toISOString() };
      await fs.writeFile(lockPath, `${JSON.stringify(foreign, null, 2)}\n`, "utf8");

      await new Promise<void>((resolve) => {
        scheduleWorkspaceInstanceLockRefresh(dir, roots, () => resolve());
      });
      expect(isSecondaryWorkspaceInstanceReadOnly()).toBe(false);
      const raw2 = await fs.readFile(lockPath, "utf8");
      const body2 = JSON.parse(raw2) as { pid: number };
      expect(body2.pid).toBe(process.pid);
      expect(isSecondaryWorkspaceInstanceReadOnly()).toBe(false);
    } finally {
      await disposeWorkspaceInstanceLock();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
