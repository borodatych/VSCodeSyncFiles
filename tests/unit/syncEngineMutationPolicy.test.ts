/**
 * The checkpoint as behaviour, not as a unit (finding F2).
 *
 * `syncPolicy.test.ts` proves the decision; this proves the engine acts on it —
 * that an automatic engine refuses to move bytes, that the refusal names the
 * operation, and that the divergence detector keeps working, which is the whole
 * point of gating half of `syncWorkspace` instead of all of it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { SyncEngine } from "../../src/core/syncEngine.js";
import { MutationDeniedError } from "../../src/core/syncPolicy.js";
import { WorkspaceConfigManager } from "../../src/core/workspaceConfigManager.js";

describe("SyncEngine — чекпоинт мутации", () => {
  let roots: string[] = [];

  afterEach(async () => {
    for (const r of roots) {
      await fs.rm(r, { recursive: true, force: true });
    }
    roots = [];
  });

  async function setup(): Promise<{
    provider: MockCloudProvider;
    root: string;
    user: SyncEngine;
    auto: SyncEngine;
    wsId: string;
    filePath: string;
  }> {
    const provider = new MockCloudProvider("onedrive");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-mutpolicy-"));
    roots.push(root);

    const user = new SyncEngine({
      workspaceRoot: root,
      provider,
      machineId: "m1",
      machineName: "M1",
      trigger: "user",
    });
    const auto = new SyncEngine({
      workspaceRoot: root,
      provider,
      machineId: "m1",
      machineName: "M1",
      trigger: "auto",
    });

    const wsId = await user.createWorkspace("policy-ws", "onedrive");
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "one");
    await user.addFiles(wsId, [filePath]);

    return { provider, root, user, auto, wsId, filePath };
  }

  it("автоматический движок отклоняет операции, двигающие данные", async () => {
    const { auto, wsId, filePath } = await setup();

    await expect(auto.pushAll(wsId)).rejects.toBeInstanceOf(MutationDeniedError);
    await expect(auto.pullAll(wsId)).rejects.toBeInstanceOf(MutationDeniedError);
    await expect(auto.syncWorkspace(wsId)).rejects.toBeInstanceOf(MutationDeniedError);
    await expect(auto.addFiles(wsId, [filePath])).rejects.toBeInstanceOf(MutationDeniedError);
    await expect(auto.createWorkspace("nope", "onedrive")).rejects.toBeInstanceOf(MutationDeniedError);
    await expect(auto.detachWorkspaceLocal(wsId)).rejects.toBeInstanceOf(MutationDeniedError);
  });

  it("отказ называет операцию и триггер", async () => {
    const { auto, wsId } = await setup();
    let caught: unknown;
    try {
      await auto.pushAll(wsId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MutationDeniedError);
    expect((caught as MutationDeniedError).op).toBe("pushAll");
    expect((caught as MutationDeniedError).trigger).toBe("auto");
  });

  it("автоматический движок не пишет в облако ни одного байта", async () => {
    const { provider, auto, wsId } = await setup();
    const before = new Map(provider.files);

    await auto.pushAll(wsId).catch(() => undefined);
    await auto.syncWorkspace(wsId).catch(() => undefined);
    // The detector is allowed and must not write either.
    await auto.checkWorkspaceStatus(wsId);

    expect([...provider.files.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, v] of provider.files) {
      expect(v.etag).toBe(before.get(k)?.etag);
    }
  });

  it("детектор расхождений работает под автоматическим триггером", async () => {
    const { provider, user, auto, wsId, filePath, root } = await setup();
    // Get to a synced state first, then diverge locally: the detector must see
    // the file needs pushing and must not push it to fix that.
    await user.pushAll(wsId);
    await fs.writeFile(filePath, "one-changed");
    const cloudBefore = new Map(provider.files);

    await expect(auto.checkWorkspaceStatus(wsId)).resolves.toBeUndefined();

    const cfg = await WorkspaceConfigManager.load(root);
    const entry = cfg.files.find((f) => f.localPath === "a.txt");
    expect(entry?.syncStatus).toBe("pending_push");
    expect([...provider.files.keys()].sort()).toEqual([...cloudBefore.keys()].sort());
  });

  it("пользовательский движок делает то же самое без отказа", async () => {
    const { provider, user, wsId, filePath } = await setup();
    await fs.writeFile(filePath, "one-changed");
    const etagBefore = [...provider.files.entries()].find(([k]) => k.endsWith("a.txt"))?.[1].etag;

    await expect(user.pushAll(wsId)).resolves.toBeDefined();

    const etagAfter = [...provider.files.entries()].find(([k]) => k.endsWith("a.txt"))?.[1].etag;
    expect(etagAfter).not.toBe(etagBefore);
  });
});
