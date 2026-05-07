import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendActivityEvent, loadActivityFile } from "../../src/core/activityLog.js";

describe("activityLog", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("appends events with schema 1", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-act-"));
    await appendActivityEvent(
      dir,
      {
        kind: "push",
        workspaceId: "ws1",
        workspaceNote: "Note",
        relPath: "a/b.ts",
        machineName: "home",
        provider: "onedrive",
      },
      90,
    );
    const f = await loadActivityFile(dir);
    expect(f.schema).toBe(1);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.kind).toBe("push");
    expect(f.events[0]?.relPath).toBe("a/b.ts");
    expect(f.events[0]?.id).toBeTruthy();
    expect(f.events[0]?.at).toBeTruthy();
  });

  it("prunes events older than retention", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-act-"));
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const fp = path.join(dir, "activity.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      fp,
      JSON.stringify({
        schema: 1,
        events: [
          {
            id: "x",
            at: old,
            kind: "pull",
            workspaceId: "w",
            workspaceNote: "",
            relPath: "f.ts",
            machineName: "m",
            provider: "onedrive",
          },
        ],
      }),
      "utf8",
    );
    await appendActivityEvent(
      dir,
      {
        kind: "push",
        workspaceId: "w",
        workspaceNote: "",
        relPath: "g.ts",
        machineName: "m",
        provider: "onedrive",
      },
      90,
    );
    const f = await loadActivityFile(dir);
    expect(f.events.every((e) => Date.parse(e.at) >= Date.now() - 91 * 86_400_000)).toBe(true);
    expect(f.events.some((e) => e.relPath === "g.ts")).toBe(true);
  });
});
