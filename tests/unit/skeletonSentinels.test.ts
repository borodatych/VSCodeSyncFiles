/**
 * Smoke tests for Phase 12 skeleton modules: pure helpers do useful work,
 * and the not-yet-implemented entry points throw a named sentinel error so
 * any UI caller can route to a "needs work" placeholder instead of failing
 * silently.
 */
import { describe, expect, it } from "vitest";
import {
  planSnapshotDiff,
  renderDiff,
  SnapshotDiffViewerNotImplementedError,
} from "../../src/core/snapshotDiffViewer.js";
import {
  buildTimeTravelModel,
  renderScrubber,
  TimeTravelScrubberNotImplementedError,
} from "../../src/core/timeTravelScrubber.js";
import {
  scoreConflictRisk,
  subscribePresenceWire,
  SmartConflictPredictionNotImplementedError,
} from "../../src/core/smartConflictPrediction.js";
import { planBulkPush } from "../../src/core/bulkPushWizard.js";
import {
  summariseHoverDiff,
  attachHoverProvider,
  HoverDiffPreviewNotImplementedError,
} from "../../src/core/hoverDiffPreview.js";
import {
  validateWorkspaceTemplate,
  installTemplate,
  WorkspaceTemplatesNotImplementedError,
} from "../../src/core/workspaceTemplates.js";
import {
  evaluateAchievements,
  showAchievementPopup,
  AchievementsNotImplementedError,
} from "../../src/core/achievements.js";
import type { ActivityEvent } from "../../src/core/activityLog.js";

describe("snapshotDiffViewer", () => {
  it("planSnapshotDiff marks identical content", () => {
    const plan = planSnapshotDiff({
      relPath: "a.ts",
      left: { workspaceId: "w", snapshotName: "v1", createdAtMs: 1 },
      right: { workspaceId: "w", snapshotName: "v2", createdAtMs: 2 },
      leftContent: "x",
      rightContent: "x",
    });
    expect(plan.identical).toBe(true);
    expect(plan.title).toContain("a.ts");
  });
  it("renderDiff throws sentinel", () => {
    expect(() =>
      renderDiff({
        relPath: "a.ts",
        left: { workspaceId: "w", snapshotName: "v1", createdAtMs: 1 },
        right: { workspaceId: "w", snapshotName: "v2", createdAtMs: 2 },
        leftContent: "x",
        rightContent: "y",
      }),
    ).toThrow(SnapshotDiffViewerNotImplementedError);
  });
});

describe("timeTravelScrubber", () => {
  it("buildTimeTravelModel returns empty model on empty input", () => {
    const m = buildTimeTravelModel([]);
    expect(m.ticks).toEqual([]);
    expect(m.totalSpanMs).toBe(0);
  });
  it("buildTimeTravelModel positions ticks across [0,1]", () => {
    const m = buildTimeTravelModel([
      { cloudPath: "p/v1", createdAtMs: 100, machineName: "m1", size: 10 },
      { cloudPath: "p/v2", createdAtMs: 200, machineName: "m2", size: 12 },
      { cloudPath: "p/v3", createdAtMs: 300, machineName: "m1", size: 11 },
    ]);
    expect(m.ticks).toHaveLength(3);
    expect(m.ticks[0].positionFraction).toBe(0);
    expect(m.ticks[2].positionFraction).toBe(1);
  });
  it("renderScrubber throws sentinel", () => {
    expect(() => renderScrubber({ ticks: [], earliestMs: 0, latestMs: 0, totalSpanMs: 0 })).toThrow(
      TimeTravelScrubberNotImplementedError,
    );
  });
});

describe("smartConflictPrediction", () => {
  it("scoreConflictRisk returns 0 with no concurrent editors", () => {
    const r = scoreConflictRisk({
      myMachineName: "alpha",
      myEditingPath: "a.ts",
      others: [],
      nowMs: 1_000_000,
    });
    expect(r.score).toBe(0);
  });
  it("scoreConflictRisk fires when another machine is active on same path", () => {
    const r = scoreConflictRisk({
      myMachineName: "alpha",
      myEditingPath: "a.ts",
      others: [{ machineName: "beta", relPath: "a.ts", startedAtMs: 0, lastSeenMs: 1_000_000 }],
      nowMs: 1_000_000,
    });
    expect(r.score).toBeGreaterThan(0);
    expect(r.activeOthers).toEqual(["beta"]);
  });
  it("subscribePresenceWire throws sentinel", () => {
    expect(() => subscribePresenceWire()).toThrow(SmartConflictPredictionNotImplementedError);
  });
});

describe("bulkPushWizard", () => {
  it("planBulkPush filters out workspaces with no pending files", () => {
    const plan = planBulkPush([
      { workspaceId: "w1", workspaceNote: "One", pendingFileCount: 5 },
      { workspaceId: "w2", workspaceNote: "Two", pendingFileCount: 0 },
    ]);
    expect(plan.totalWorkspaces).toBe(1);
    expect(plan.totalPendingFiles).toBe(5);
  });
  // Note: BulkPushWizard skeleton was upgraded to a full impl on roadmap-max
  // pass 5; the sentinel was removed. The pure planner stays here as the
  // canonical "what to push next" helper.
});

describe("hoverDiffPreview", () => {
  it("summariseHoverDiff says identical when hashes match", () => {
    const text = summariseHoverDiff({
      relPath: "a.ts",
      localHash: "abc",
      cloudHash: "abc",
      cloudSize: 1024,
      cloudUpdatedAtMs: Date.now(),
      cloudEditorMachine: "beta",
    });
    expect(text).toContain("identical");
  });
  it("attachHoverProvider throws sentinel", () => {
    expect(() => attachHoverProvider()).toThrow(HoverDiffPreviewNotImplementedError);
  });
});

describe("workspaceTemplates", () => {
  it("validateWorkspaceTemplate accepts a well-formed template", () => {
    const r = validateWorkspaceTemplate({
      id: "t1",
      title: "Sample",
      description: "Sample template",
      tags: ["sample"],
      files: [{ relPath: "README.md", content: "# Hi" }],
    });
    expect(r.ok).toBe(true);
  });
  it("validateWorkspaceTemplate rejects path-traversal", () => {
    const r = validateWorkspaceTemplate({
      id: "t1",
      title: "Sample",
      description: "x",
      tags: [],
      files: [{ relPath: "../escape.txt", content: "" }],
    });
    expect(r.ok).toBe(false);
  });
  it("installTemplate throws sentinel", () => {
    expect(() =>
      installTemplate({ id: "t", title: "T", description: "", tags: [], files: [] }, "/tmp"),
    ).toThrow(WorkspaceTemplatesNotImplementedError);
  });
});

describe("achievements", () => {
  function ev(over: Partial<ActivityEvent>): ActivityEvent {
    return {
      id: "x",
      at: new Date().toISOString(),
      kind: "push",
      workspaceId: "w",
      workspaceNote: "W",
      relPath: "a.ts",
      machineName: "alpha",
      provider: "onedrive",
      ...over,
    };
  }
  it("evaluateAchievements unlocks first-push and first-pull", () => {
    const events = [ev({ kind: "push" }), ev({ kind: "pull" })];
    const got = evaluateAchievements(events).map((a) => a.id);
    expect(got).toContain("first-push");
    expect(got).toContain("first-pull");
  });
  it("evaluateAchievements unlocks five-machines after 5 distinct names", () => {
    const events = ["a", "b", "c", "d", "e"].map((m) => ev({ machineName: m }));
    const got = evaluateAchievements(events).map((a) => a.id);
    expect(got).toContain("five-machines");
  });
  it("showAchievementPopup throws sentinel", () => {
    expect(() =>
      showAchievementPopup({ id: "x", title: "X", description: "", unlockedAtMs: 0 }),
    ).toThrow(AchievementsNotImplementedError);
  });
});
