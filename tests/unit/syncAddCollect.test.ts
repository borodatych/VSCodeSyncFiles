import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { collectFilesToAddUnderRoots } from "../../src/utils/syncAddCollect.js";

async function mktemp(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vsc-sync-collect-"));
}

describe("collectFilesToAddUnderRoots", () => {
  it("рекурсивно собирает файлы и пропускает ignore из .vscodesync-ignore", async () => {
    const root = await mktemp();
    await fs.mkdir(path.join(root, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(root, "a", "keep.txt"), "x", "utf8");
    await fs.writeFile(path.join(root, "a", "b", "drop.txt"), "y", "utf8");
    await fs.writeFile(path.join(root, ".vscodesync-ignore"), "drop.txt\n", "utf8");

    const files = await collectFilesToAddUnderRoots(root, [path.join(root, "a")], {});
    expect(files.map((f) => path.relative(root, f).split(path.sep).join("/")).sort()).toEqual(["a/keep.txt"]);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("не выходит за пределы workspace root", async () => {
    const root = await mktemp();
    const outside = await mktemp();
    await fs.writeFile(path.join(root, "in.txt"), "1", "utf8");
    await fs.writeFile(path.join(outside, "out.txt"), "2", "utf8");

    const files = await collectFilesToAddUnderRoots(root, [path.join(root, "in.txt"), path.join(outside, "out.txt")], {});
    expect(files.length).toBe(1);

    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
});
