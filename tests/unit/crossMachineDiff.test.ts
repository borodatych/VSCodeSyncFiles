import { describe, expect, it } from "vitest";
import { buildCrossMachineDiff } from "../../src/core/crossMachineDiff.js";

describe("buildCrossMachineDiff", () => {
  it("excludes my own pushes", () => {
    const r = buildCrossMachineDiff({
      myMachineId: "me",
      metaRows: [
        { posixRel: "a", pusherMachineId: "me", updatedAt: "2026-05-21T00:00:00Z" },
        { posixRel: "b", pusherMachineId: "other", updatedAt: "2026-05-21T00:01:00Z" },
      ],
    });
    expect(r.entries.find((e) => e.posixRel === "a")).toBeUndefined();
    expect(r.entries.find((e) => e.posixRel === "b")).toBeDefined();
  });

  it("respects mySinceIso filter", () => {
    const r = buildCrossMachineDiff({
      myMachineId: "me",
      mySinceIso: "2026-05-20T12:00:00Z",
      metaRows: [
        { posixRel: "old", pusherMachineId: "other", updatedAt: "2026-05-10T00:00:00Z" },
        { posixRel: "new", pusherMachineId: "other", updatedAt: "2026-05-21T00:00:00Z" },
      ],
    });
    expect(r.entries.map((e) => e.posixRel)).toEqual(["new"]);
  });

  it("groups by machine", () => {
    const r = buildCrossMachineDiff({
      myMachineId: "me",
      metaRows: [
        { posixRel: "a", pusherMachineId: "alice", updatedAt: "2026-05-21T00:00:00Z" },
        { posixRel: "b", pusherMachineId: "alice", updatedAt: "2026-05-21T01:00:00Z" },
        { posixRel: "c", pusherMachineId: "bob", updatedAt: "2026-05-21T02:00:00Z" },
      ],
      machineLabels: { alice: "Alice's Mac", bob: "Bob's PC" },
    });
    expect(r.byMachine).toHaveLength(2);
    const alice = r.byMachine.find((m) => m.machineId === "alice");
    expect(alice?.count).toBe(2);
    expect(alice?.machineLabel).toBe("Alice's Mac");
  });

  it("sorts entries newest-first", () => {
    const r = buildCrossMachineDiff({
      myMachineId: "me",
      metaRows: [
        { posixRel: "old", pusherMachineId: "x", updatedAt: "2026-01-01T00:00:00Z" },
        { posixRel: "new", pusherMachineId: "x", updatedAt: "2026-05-21T00:00:00Z" },
        { posixRel: "mid", pusherMachineId: "x", updatedAt: "2026-03-15T00:00:00Z" },
      ],
    });
    expect(r.entries.map((e) => e.posixRel)).toEqual(["new", "mid", "old"]);
  });

  it("skips malformed timestamps", () => {
    const r = buildCrossMachineDiff({
      myMachineId: "me",
      metaRows: [
        { posixRel: "bad", pusherMachineId: "x", updatedAt: "not-a-date" },
        { posixRel: "good", pusherMachineId: "x", updatedAt: "2026-05-21T00:00:00Z" },
      ],
    });
    expect(r.entries.map((e) => e.posixRel)).toEqual(["good"]);
  });
});
