import { describe, expect, it } from "vitest";
import { validateRestoreState } from "../../src/core/workspaceRestoreValidator.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;

describe("validateRestoreState — happy path", () => {
  it("reports restoreSafe=true and no issues for a consistent state", () => {
    const r = validateRestoreState({
      workspaceId: "ws1",
      manifest: [
        { relPath: "a.txt", hash: "h1", updatedAtMs: NOW },
        { relPath: "b.txt", hash: "h2", updatedAtMs: NOW },
      ],
      meta: [
        { relPath: "a.txt", hash: "h1", updatedAtMs: NOW },
        { relPath: "b.txt", hash: "h2", updatedAtMs: NOW },
      ],
      snapshots: [{ name: "2026-01-01", createdAtMs: NOW - DAY, fileCount: 2 }],
      nowMs: NOW,
    });
    expect(r.restoreSafe).toBe(true);
    expect(r.issues).toEqual([]);
  });
});

describe("validateRestoreState — manifest/meta consistency", () => {
  it("flags manifest_meta_path_mismatch when a manifest entry has no meta", () => {
    const r = validateRestoreState({
      workspaceId: "ws1",
      manifest: [
        { relPath: "a.txt", hash: "h1", updatedAtMs: NOW },
        { relPath: "b.txt", hash: "h2", updatedAtMs: NOW },
      ],
      meta: [{ relPath: "a.txt", hash: "h1", updatedAtMs: NOW }],
      snapshots: [{ name: "2026-01-01", createdAtMs: NOW, fileCount: 1 }],
      nowMs: NOW,
    });
    expect(r.restoreSafe).toBe(false);
    const issue = r.issues.find((i) => i.kind === "manifest_meta_path_mismatch");
    expect(issue?.ref).toBe("b.txt");
    expect(issue?.severity).toBe("error");
  });

  it("flags manifest_meta_hash_mismatch when hashes diverge", () => {
    const r = validateRestoreState({
      workspaceId: "ws1",
      manifest: [{ relPath: "a.txt", hash: "h1", updatedAtMs: NOW }],
      meta: [{ relPath: "a.txt", hash: "h2", updatedAtMs: NOW }],
      snapshots: [{ name: "2026-01-01", createdAtMs: NOW, fileCount: 1 }],
      nowMs: NOW,
    });
    expect(r.restoreSafe).toBe(false);
    expect(r.issues.some((i) => i.kind === "manifest_meta_hash_mismatch")).toBe(true);
  });

  it("emits meta_orphan as warning, not error (restore can still proceed)", () => {
    const r = validateRestoreState({
      workspaceId: "ws1",
      manifest: [{ relPath: "a.txt", hash: "h1", updatedAtMs: NOW }],
      meta: [
        { relPath: "a.txt", hash: "h1", updatedAtMs: NOW },
        { relPath: "leftover.txt", hash: "hX", updatedAtMs: NOW },
      ],
      snapshots: [{ name: "2026-01-01", createdAtMs: NOW, fileCount: 1 }],
      nowMs: NOW,
    });
    expect(r.restoreSafe).toBe(true);
    expect(r.issues.find((i) => i.kind === "meta_orphan")?.severity).toBe("warning");
  });
});

describe("validateRestoreState — snapshots", () => {
  it("warns when no snapshots exist", () => {
    const r = validateRestoreState({
      workspaceId: "ws1",
      manifest: [{ relPath: "a.txt", hash: "h1", updatedAtMs: NOW }],
      meta: [{ relPath: "a.txt", hash: "h1", updatedAtMs: NOW }],
      snapshots: [],
      nowMs: NOW,
    });
    expect(r.restoreSafe).toBe(true);
    expect(r.issues.find((i) => i.kind === "no_snapshots")?.severity).toBe("warning");
  });

  it("flags duplicate snapshot names as error", () => {
    const r = validateRestoreState({
      workspaceId: "ws1",
      manifest: [{ relPath: "a.txt", hash: "h1", updatedAtMs: NOW }],
      meta: [{ relPath: "a.txt", hash: "h1", updatedAtMs: NOW }],
      snapshots: [
        { name: "dup", createdAtMs: NOW - DAY, fileCount: 1 },
        { name: "dup", createdAtMs: NOW - 2 * DAY, fileCount: 1 },
      ],
      nowMs: NOW,
    });
    expect(r.restoreSafe).toBe(false);
    expect(r.issues.find((i) => i.kind === "duplicate_snapshot_name")).toBeDefined();
  });

  it("emits stale_snapshot at info severity past the threshold", () => {
    const r = validateRestoreState({
      workspaceId: "ws1",
      manifest: [{ relPath: "a.txt", hash: "h1", updatedAtMs: NOW }],
      meta: [{ relPath: "a.txt", hash: "h1", updatedAtMs: NOW }],
      snapshots: [{ name: "old", createdAtMs: NOW - 200 * DAY, fileCount: 1 }],
      nowMs: NOW,
    });
    expect(r.restoreSafe).toBe(true);
    expect(r.issues.find((i) => i.kind === "stale_snapshot")?.severity).toBe("info");
  });

  it("respects a caller-supplied staleSnapshotMs", () => {
    const r = validateRestoreState({
      workspaceId: "ws1",
      manifest: [],
      meta: [],
      snapshots: [{ name: "yesterday", createdAtMs: NOW - DAY, fileCount: 1 }],
      nowMs: NOW,
      staleSnapshotMs: 60_000,
    });
    expect(r.issues.some((i) => i.kind === "stale_snapshot")).toBe(true);
  });
});

describe("validateRestoreState — counts", () => {
  it("aggregates issueCount/errorCount/warningCount/infoCount correctly", () => {
    const r = validateRestoreState({
      workspaceId: "ws1",
      manifest: [
        { relPath: "a.txt", hash: "h1", updatedAtMs: NOW },
        { relPath: "missing.txt", hash: "hX", updatedAtMs: NOW },
      ],
      meta: [
        { relPath: "a.txt", hash: "DIFFERENT", updatedAtMs: NOW },
        { relPath: "orphan.txt", hash: "hY", updatedAtMs: NOW },
      ],
      snapshots: [{ name: "old", createdAtMs: NOW - 200 * DAY, fileCount: 0 }],
      nowMs: NOW,
    });
    expect(r.errorCount).toBe(2); // path mismatch + hash mismatch
    expect(r.warningCount).toBe(1); // meta orphan
    expect(r.infoCount).toBe(1); // stale snapshot
    expect(r.issueCount).toBe(4);
    expect(r.restoreSafe).toBe(false);
  });
});
