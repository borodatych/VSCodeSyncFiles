import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceConfigManager } from "../../src/core/workspaceConfigManager.js";

describe("WorkspaceConfigManager", () => {
  let dir: string;

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("load возвращает дефолт при отсутствии файла", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-ws-"));
    const cfg = await WorkspaceConfigManager.load(dir);
    expect(cfg.activeWorkspaces).toEqual([]);
    expect(cfg.files).toEqual([]);
  });

  it("save и load круговой путь", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-ws-"));
    const cfg = {
      activeWorkspaces: [{ workspaceId: "w1", workspaceNote: "n" }],
      files: [
        {
          localPath: "a/b.txt",
          workspaceId: "w1",
          cloudPath: "x/y.txt",
          lastSync: new Date().toISOString(),
          localHash: "deadbeef",
        },
      ],
    };
    await WorkspaceConfigManager.save(cfg, dir);
    const again = await WorkspaceConfigManager.load(dir);
    expect(again).toEqual(cfg);
  });
});
