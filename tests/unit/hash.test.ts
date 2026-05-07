import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeHash } from "../../src/utils/hash.js";
import { stripSyncignoreBlocks } from "../../src/utils/syncignore.js";
import { toPosixPath } from "../../src/utils/paths.js";

describe("hash + syncignore", () => {
  let dir: string;

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("UTF-8 BOM даёт тот же канонический хэш, что файл без BOM (lf)", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-hash-"));
    const bomFile = path.join(dir, "bom.txt");
    const plainFile = path.join(dir, "plain.txt");
    const bomBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("same\n", "utf8")]);
    await fs.writeFile(bomFile, bomBuf);
    await fs.writeFile(plainFile, "same\n", "utf8");
    const hb = await computeHash(bomFile, { lineEnding: "lf" });
    const hp = await computeHash(plainFile, { lineEnding: "lf" });
    expect(hb).toBe(hp);
  });

  it("CRLF и LF дают один хэш при режиме lf", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-hash-"));
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    await fs.writeFile(a, "line1\r\nline2\r\n", "utf8");
    await fs.writeFile(b, "line1\nline2\n", "utf8");
    const ha = await computeHash(a, { lineEnding: "lf" });
    const hb = await computeHash(b, { lineEnding: "lf" });
    expect(ha).toBe(hb);
  });

  it("stripSyncignoreBlocks вырезает блок", () => {
    const src = `before
vsync-ignore-start
skip
vsync-ignore-end
after
`;
    expect(stripSyncignoreBlocks(src).includes("skip")).toBe(false);
    expect(stripSyncignoreBlocks(src).includes("after")).toBe(true);
  });

  it("toPosixPath на Windows-стиле", () => {
    expect(toPosixPath("a\\b\\c")).toBe("a/b/c");
  });
});
