import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../../src/core/activityLog.js";
import {
  analyzeCoEditClusters,
  clusterAlreadySingleLocalWorkspace,
  clusterHasMultipleWorkspaceIdsInActivity,
  COEDIT_MIN_SAME_DAY,
  COEDIT_WINDOW_MS,
} from "../../src/core/smartSuggestionsModel.js";

function evLocal(
  year: number,
  month: number,
  day: number,
  relPath: string,
  workspaceId: string,
  kind: ActivityEvent["kind"] = "push",
): ActivityEvent {
  const d = new Date(year, month - 1, day, 14, 0, 0);
  return {
    id: "x",
    at: d.toISOString(),
    kind,
    workspaceId,
    workspaceNote: "",
    relPath,
    machineName: "m",
    provider: "onedrive",
  };
}

describe("smartSuggestionsModel", () => {
  it("finds cluster when two paths sync on same calendar day from different workspaces at least 5 days", () => {
    const events: ActivityEvent[] = [];
    const wA = "ws-a";
    const wB = "ws-b";
    for (let i = 0; i < COEDIT_MIN_SAME_DAY; i++) {
      const day = 10 - i;
      events.push(evLocal(2026, 4, day, "src/a.ts", wA));
      events.push(evLocal(2026, 4, day, "src/b.ts", wB));
    }
    const now = new Date(2026, 3, 14, 12, 0, 0).getTime();
    const clusters = analyzeCoEditClusters(events, now, { windowMs: COEDIT_WINDOW_MS, minSameDay: COEDIT_MIN_SAME_DAY });
    expect(clusters.length).toBe(1);
    expect(clusters[0]?.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(clusters[0]?.score).toBeGreaterThanOrEqual(COEDIT_MIN_SAME_DAY);
    expect(clusterHasMultipleWorkspaceIdsInActivity(clusters[0]?.paths ?? [], events, now, COEDIT_WINDOW_MS)).toBe(true);
  });

  it("skips when all paths tracked under same workspace locally", () => {
    const wc = {
      activeWorkspaces: [{ workspaceId: "w1", workspaceNote: "x" }],
      files: [
        { localPath: "a.ts", workspaceId: "w1", cloudPath: "", lastSync: "2026-01-01T00:00:00Z", localHash: "h" },
        { localPath: "b.ts", workspaceId: "w1", cloudPath: "", lastSync: "2026-01-01T00:00:00Z", localHash: "h" },
      ],
    };
    expect(clusterAlreadySingleLocalWorkspace(["a.ts", "b.ts"], [{ wc }])).toBe(true);
  });
});
