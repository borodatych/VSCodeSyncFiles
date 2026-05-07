/**
 * Tests for `sortPriorityFirst` — pinned (priority: true) push/pull items go
 * before regular file ops; fullSync stays at the head, quickTransfer at the
 * tail. The drain order is what determines the actual flush sequence.
 */
import { describe, it, expect } from "vitest";
import {
  sortPriorityFirst,
  type OfflineQueueItem,
} from "../../src/core/syncOfflineQueueStore.js";

function push(rel: string, priority = false): OfflineQueueItem {
  return { kind: "push", root: "/r", rel, workspaceId: "ws", ...(priority ? { priority: true } : {}) };
}
function pull(rel: string, priority = false): OfflineQueueItem {
  return { kind: "pull", root: "/r", rel, workspaceId: "ws", ...(priority ? { priority: true } : {}) };
}

describe("sortPriorityFirst", () => {
  it("preserves order when there are no pins and no fullSync", () => {
    const items: OfflineQueueItem[] = [push("a"), pull("b"), push("c")];
    expect(sortPriorityFirst(items)).toEqual(items);
  });

  it("moves pinned push/pull ahead of regular ones", () => {
    const items: OfflineQueueItem[] = [push("a"), push("b", true), pull("c"), pull("d", true)];
    const out = sortPriorityFirst(items);
    expect(out.map((i) => ("rel" in i ? i.rel : i.kind))).toEqual(["b", "d", "a", "c"]);
  });

  it("keeps fullSync at the head, even when pins are present", () => {
    const items: OfflineQueueItem[] = [
      push("a"),
      push("pinned", true),
      { kind: "fullSync" },
      pull("b"),
    ];
    const out = sortPriorityFirst(items);
    expect(out[0]).toEqual({ kind: "fullSync" });
    expect(out[1]).toEqual(push("pinned", true));
  });

  it("keeps quickTransfer at the tail, regardless of pinned ops", () => {
    const items: OfflineQueueItem[] = [
      {
        kind: "quickTransferSend",
        queuedAtIso: "2026-05-07T00:00:00Z",
        ttlDays: 7,
        absolutePath: "/abs/x.txt",
        projectRelativePosix: "x.txt",
      },
      push("file", true),
    ];
    const out = sortPriorityFirst(items);
    expect(out[0]).toEqual(push("file", true));
    expect(out[1].kind).toBe("quickTransferSend");
  });

  it("preserves stable order among pinned items themselves", () => {
    const items: OfflineQueueItem[] = [
      push("first-pin", true),
      pull("second-pin", true),
      push("third-pin", true),
    ];
    const out = sortPriorityFirst(items);
    expect(out.map((i) => ("rel" in i ? i.rel : ""))).toEqual([
      "first-pin",
      "second-pin",
      "third-pin",
    ]);
  });

  it("handles empty input", () => {
    expect(sortPriorityFirst([])).toEqual([]);
  });
});
