/**
 * Tests for `dedupeOfflineQueue` — collapses duplicate push/pull entries for
 * the same `{root, rel, workspaceId}` into the latest version. Saves cloud
 * quota when offline accumulates 5× pushes of the same file before reconnect.
 */
import { describe, it, expect } from "vitest";
import {
  dedupeOfflineQueue,
  type OfflineQueueItem,
} from "../../src/core/syncOfflineQueueStore.js";

function push(rel: string, priority = false): OfflineQueueItem {
  return {
    kind: "push",
    root: "/r",
    rel,
    workspaceId: "ws",
    ...(priority ? { priority: true } : {}),
  };
}
function pull(rel: string): OfflineQueueItem {
  return { kind: "pull", root: "/r", rel, workspaceId: "ws" };
}

describe("dedupeOfflineQueue", () => {
  it("returns input unchanged when no duplicates", () => {
    const items: OfflineQueueItem[] = [push("a"), push("b"), pull("c")];
    expect(dedupeOfflineQueue(items)).toEqual(items);
  });

  it("collapses 5× push of the same file to one entry", () => {
    const items: OfflineQueueItem[] = [
      push("file.ts"),
      push("file.ts"),
      push("file.ts"),
      push("file.ts"),
      push("file.ts"),
    ];
    const out = dedupeOfflineQueue(items);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(push("file.ts"));
  });

  it("does not collapse push and pull for the same path (different kind)", () => {
    const items: OfflineQueueItem[] = [push("file.ts"), pull("file.ts")];
    expect(dedupeOfflineQueue(items)).toHaveLength(2);
  });

  it("propagates priority bit when any duplicate was pinned", () => {
    const items: OfflineQueueItem[] = [
      push("file.ts"),
      push("file.ts", true),
      push("file.ts"),
    ];
    const out = dedupeOfflineQueue(items);
    expect(out).toHaveLength(1);
    expect(
      out[0].kind === "push" && out[0].priority === true,
    ).toBe(true);
  });

  it("preserves fullSync at head", () => {
    const items: OfflineQueueItem[] = [
      { kind: "fullSync" },
      push("a"),
      push("a"),
    ];
    const out = dedupeOfflineQueue(items);
    expect(out[0]).toEqual({ kind: "fullSync" });
    expect(out).toHaveLength(2);
  });

  it("preserves quickTransfer at tail", () => {
    const items: OfflineQueueItem[] = [
      push("a"),
      push("a"),
      {
        kind: "quickTransferSend",
        queuedAtIso: "2026-05-01T00:00:00Z",
        ttlDays: 7,
        absolutePath: "/abs/x",
        projectRelativePosix: "x",
      },
    ];
    const out = dedupeOfflineQueue(items);
    expect(out).toHaveLength(2);
    expect(out[0].kind).toBe("push");
    expect(out[1].kind).toBe("quickTransferSend");
  });

  it("normalises root path on Windows-vs-POSIX casing", () => {
    const items: OfflineQueueItem[] = [
      { kind: "push", root: "C:\\Project", rel: "a", workspaceId: "ws" },
      { kind: "push", root: "C:/project", rel: "a", workspaceId: "ws" },
    ];
    const out = dedupeOfflineQueue(items);
    expect(out).toHaveLength(1);
  });

  it("empty input → empty output", () => {
    expect(dedupeOfflineQueue([])).toEqual([]);
  });
});
