import { describe, expect, it } from "vitest";
import {
  findInactiveWorkspaceCandidates,
  inactiveSnoozeKey,
  isInactiveSnoozeActive,
  INACTIVE_SNOOZE_NEVER,
  type InactiveWorkspaceFolderInput,
} from "../../src/core/inactiveWorkspaceCandidates.js";

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

function ago(days: number): number {
  return NOW - days * DAY_MS;
}

function folder(
  path: string,
  workspaces: { id: string; note?: string; archived?: boolean; active?: boolean; lastSyncMs?: number | undefined }[],
): InactiveWorkspaceFolderInput {
  return {
    folderRootFsPath: path,
    workspaces: workspaces.map((w) => ({
      workspaceId: w.id,
      workspaceNote: w.note ?? w.id,
      archived: w.archived ?? false,
      active: w.active ?? true,
      lastSyncMs: "lastSyncMs" in w ? w.lastSyncMs : ago(100),
    })),
  };
}

describe("findInactiveWorkspaceCandidates — basic filtering", () => {
  it("returns empty when no folders", () => {
    const r = findInactiveWorkspaceCandidates({ folders: [], minInactiveDays: 30, nowMs: NOW });
    expect(r).toEqual([]);
  });

  it("skips workspaces below the lower threshold", () => {
    const r = findInactiveWorkspaceCandidates({
      folders: [folder("/a", [{ id: "w1", lastSyncMs: ago(10) }])],
      minInactiveDays: 30,
      nowMs: NOW,
    });
    expect(r).toEqual([]);
  });

  it("returns candidates above the lower threshold", () => {
    const r = findInactiveWorkspaceCandidates({
      folders: [folder("/a", [{ id: "w1", lastSyncMs: ago(40) }])],
      minInactiveDays: 30,
      nowMs: NOW,
    });
    expect(r.length).toBe(1);
    expect(r[0].workspaceId).toBe("w1");
    expect(r[0].inactiveDays).toBe(40);
  });

  it("skips archived workspaces", () => {
    const r = findInactiveWorkspaceCandidates({
      folders: [folder("/a", [{ id: "w1", archived: true, lastSyncMs: ago(40) }])],
      minInactiveDays: 30,
      nowMs: NOW,
    });
    expect(r).toEqual([]);
  });

  it("skips non-active workspaces", () => {
    const r = findInactiveWorkspaceCandidates({
      folders: [folder("/a", [{ id: "w1", active: false, lastSyncMs: ago(40) }])],
      minInactiveDays: 30,
      nowMs: NOW,
    });
    expect(r).toEqual([]);
  });

  it("skips workspaces with no recorded lastSyncMs", () => {
    const r = findInactiveWorkspaceCandidates({
      folders: [folder("/a", [{ id: "w1", lastSyncMs: undefined }])],
      minInactiveDays: 30,
      nowMs: NOW,
    });
    expect(r).toEqual([]);
  });
});

describe("findInactiveWorkspaceCandidates — upper bound", () => {
  it("excludes candidates >= maxInactiveDays", () => {
    const r = findInactiveWorkspaceCandidates({
      folders: [folder("/a", [{ id: "w1", lastSyncMs: ago(95) }])],
      minInactiveDays: 60,
      maxInactiveDays: 90,
      nowMs: NOW,
    });
    expect(r).toEqual([]);
  });

  it("includes candidates strictly within [min, max)", () => {
    const r = findInactiveWorkspaceCandidates({
      folders: [folder("/a", [{ id: "w1", lastSyncMs: ago(75) }])],
      minInactiveDays: 60,
      maxInactiveDays: 90,
      nowMs: NOW,
    });
    expect(r.length).toBe(1);
  });

  it("returns empty when maxInactiveDays <= minInactiveDays (invalid range)", () => {
    const r = findInactiveWorkspaceCandidates({
      folders: [folder("/a", [{ id: "w1", lastSyncMs: ago(75) }])],
      minInactiveDays: 60,
      maxInactiveDays: 60,
      nowMs: NOW,
    });
    expect(r).toEqual([]);
  });
});

describe("findInactiveWorkspaceCandidates — snooze", () => {
  it("skips snoozed workspaces (ISO timestamp in future)", () => {
    const future = new Date(NOW + 5 * DAY_MS).toISOString();
    const key = inactiveSnoozeKey("/a", "w1");
    const r = findInactiveWorkspaceCandidates({
      folders: [folder("/a", [{ id: "w1", lastSyncMs: ago(40) }])],
      minInactiveDays: 30,
      snoozes: { [key]: future },
      nowMs: NOW,
    });
    expect(r).toEqual([]);
  });

  it("includes workspaces whose snooze has expired", () => {
    const past = new Date(NOW - DAY_MS).toISOString();
    const key = inactiveSnoozeKey("/a", "w1");
    const r = findInactiveWorkspaceCandidates({
      folders: [folder("/a", [{ id: "w1", lastSyncMs: ago(40) }])],
      minInactiveDays: 30,
      snoozes: { [key]: past },
      nowMs: NOW,
    });
    expect(r.length).toBe(1);
  });

  it("skips workspaces marked never-remind", () => {
    const key = inactiveSnoozeKey("/a", "w1");
    const r = findInactiveWorkspaceCandidates({
      folders: [folder("/a", [{ id: "w1", lastSyncMs: ago(40) }])],
      minInactiveDays: 30,
      snoozes: { [key]: INACTIVE_SNOOZE_NEVER },
      nowMs: NOW,
    });
    expect(r).toEqual([]);
  });
});

describe("findInactiveWorkspaceCandidates — sorting", () => {
  it("sorts by inactiveDays desc (most-stale first)", () => {
    const r = findInactiveWorkspaceCandidates({
      folders: [
        folder("/a", [
          { id: "w-a", lastSyncMs: ago(40) },
          { id: "w-b", lastSyncMs: ago(60) },
          { id: "w-c", lastSyncMs: ago(50) },
        ]),
      ],
      minInactiveDays: 30,
      nowMs: NOW,
    });
    expect(r.map((c) => c.workspaceId)).toEqual(["w-b", "w-c", "w-a"]);
  });

  it("preserves all qualifying candidates across folders", () => {
    const r = findInactiveWorkspaceCandidates({
      folders: [
        folder("/a", [{ id: "wA", lastSyncMs: ago(35) }]),
        folder("/b", [{ id: "wB", lastSyncMs: ago(50) }]),
      ],
      minInactiveDays: 30,
      nowMs: NOW,
    });
    expect(r.length).toBe(2);
    expect(r[0].workspaceId).toBe("wB");
  });
});

describe("isInactiveSnoozeActive", () => {
  it("returns true for the never sentinel", () => {
    expect(isInactiveSnoozeActive(INACTIVE_SNOOZE_NEVER, NOW)).toBe(true);
  });

  it("returns false for undefined / empty", () => {
    expect(isInactiveSnoozeActive(undefined, NOW)).toBe(false);
    expect(isInactiveSnoozeActive("", NOW)).toBe(false);
  });

  it("returns true for a future ISO timestamp", () => {
    const future = new Date(NOW + 60_000).toISOString();
    expect(isInactiveSnoozeActive(future, NOW)).toBe(true);
  });

  it("returns false for a past ISO timestamp", () => {
    const past = new Date(NOW - 60_000).toISOString();
    expect(isInactiveSnoozeActive(past, NOW)).toBe(false);
  });

  it("returns false for malformed dates", () => {
    expect(isInactiveSnoozeActive("not-a-date", NOW)).toBe(false);
  });
});

describe("inactiveSnoozeKey", () => {
  it("returns a NUL-separated composite key", () => {
    const key = inactiveSnoozeKey("/path", "w-1");
    expect(key.length).toBe("/path".length + 1 + "w-1".length);
    expect(key.charCodeAt(5)).toBe(0); // NUL between path and id
  });
});
