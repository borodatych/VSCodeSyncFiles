import { describe, expect, it } from "vitest";
import {
  parseMachinesRegistry,
  pickUniqueMachineName,
  upsertMachineAndPrune,
  syncMachinesRegistrySelf,
} from "../../src/core/machineRegistry.js";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { machinesRegistryCloudPath } from "../../src/core/cloudLayout.js";

describe("pickUniqueMachineName", () => {
  it("keeps name when no conflict", () => {
    const entries = [
      { machineId: "a", machineName: "other", lastSeen: "2020-01-01T00:00:00.000Z" },
    ];
    expect(pickUniqueMachineName(entries, "home", "self")).toBe("home");
  });

  it("ignores own machineId", () => {
    const entries = [
      { machineId: "self", machineName: "home", lastSeen: "2020-01-01T00:00:00.000Z" },
    ];
    expect(pickUniqueMachineName(entries, "home", "self")).toBe("home");
  });

  it("appends suffix when taken by other", () => {
    const entries = [
      { machineId: "a", machineName: "home", lastSeen: "2020-01-01T00:00:00.000Z" },
      { machineId: "b", machineName: "home-2", lastSeen: "2020-01-01T00:00:00.000Z" },
    ];
    expect(pickUniqueMachineName(entries, "home", "self")).toBe("home-3");
  });
});

describe("upsertMachineAndPrune", () => {
  it("updates self and drops stale others", () => {
    const old = Date.now() - 100 * 24 * 60 * 60 * 1000;
    const entries = [
      { machineId: "stale", machineName: "x", lastSeen: new Date(old).toISOString() },
      { machineId: "self", machineName: "was", lastSeen: "2020-01-01T00:00:00.000Z" },
    ];
    const nowMs = Date.now();
    const merged = upsertMachineAndPrune(entries, "self", "new", new Date(nowMs).toISOString(), 90, nowMs);
    const ids = merged.map((e) => e.machineId).sort();
    expect(ids).toEqual(["self"]);
    expect(merged.find((e) => e.machineId === "self")?.machineName).toBe("new");
  });

  it("writes currentEditing onto self when frame is provided", () => {
    const nowMs = Date.now();
    const merged = upsertMachineAndPrune(
      [],
      "self",
      "n",
      new Date(nowMs).toISOString(),
      90,
      nowMs,
      { workspaceId: "ws-1", relPath: "src/a.ts", sinceMs: nowMs },
    );
    expect(merged[0]?.currentEditing).toEqual({
      workspaceId: "ws-1",
      relPath: "src/a.ts",
      sinceMs: nowMs,
    });
  });

  it("clears currentEditing when frame is null (idle)", () => {
    const nowMs = Date.now();
    const merged = upsertMachineAndPrune([], "self", "n", new Date(nowMs).toISOString(), 90, nowMs, null);
    expect(merged[0]?.currentEditing).toBeNull();
  });

  it("omits currentEditing field when undefined (legacy callers)", () => {
    const nowMs = Date.now();
    const merged = upsertMachineAndPrune([], "self", "n", new Date(nowMs).toISOString(), 90, nowMs);
    expect(merged[0]).not.toHaveProperty("currentEditing");
  });
});

describe("parseMachinesRegistry", () => {
  it("skips invalid rows", () => {
    const buf = Buffer.from(
      JSON.stringify([
        { machineId: "ok", machineName: "n", lastSeen: "2021-01-01T00:00:00.000Z" },
        { bad: true },
      ]),
    );
    const p = parseMachinesRegistry(buf);
    expect(p.length).toBe(1);
    expect(p[0]?.machineId).toBe("ok");
  });

  it("preserves currentEditing when shape is valid", () => {
    const buf = Buffer.from(
      JSON.stringify([
        {
          machineId: "ok",
          machineName: "n",
          lastSeen: "2021-01-01T00:00:00.000Z",
          currentEditing: { workspaceId: "w", relPath: "src/a.ts", sinceMs: 1700000000000 },
        },
      ]),
    );
    const p = parseMachinesRegistry(buf);
    expect(p[0]?.currentEditing).toEqual({
      workspaceId: "w",
      relPath: "src/a.ts",
      sinceMs: 1700000000000,
    });
  });

  it("preserves currentEditing=null (idle marker)", () => {
    const buf = Buffer.from(
      JSON.stringify([
        { machineId: "ok", machineName: "n", lastSeen: "2021-01-01T00:00:00.000Z", currentEditing: null },
      ]),
    );
    const p = parseMachinesRegistry(buf);
    expect(p[0]?.currentEditing).toBeNull();
  });

  it("drops malformed currentEditing rather than rejecting the whole row", () => {
    const buf = Buffer.from(
      JSON.stringify([
        {
          machineId: "ok",
          machineName: "n",
          lastSeen: "2021-01-01T00:00:00.000Z",
          currentEditing: { workspaceId: "", relPath: "src/a.ts", sinceMs: "not-a-number" },
        },
      ]),
    );
    const p = parseMachinesRegistry(buf);
    expect(p[0]?.machineId).toBe("ok");
    expect(p[0]?.currentEditing).toBeUndefined();
  });
});

describe("syncMachinesRegistrySelf", () => {
  it("creates file with mock provider", async () => {
    const provider = new MockCloudProvider("gdrive");
    await syncMachinesRegistrySelf(provider, "mid", "box");
    const path = machinesRegistryCloudPath();
    const meta = await provider.getMetadata(path);
    expect(meta).toBeTruthy();
    const dl = await provider.downloadFile(path);
    const rows = parseMachinesRegistry(dl.body);
    expect(rows.length).toBe(1);
    expect(rows[0]?.machineId).toBe("mid");
    expect(rows[0]?.machineName).toBe("box");
  });
});
