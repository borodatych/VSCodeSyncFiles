import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../../src/core/activityLog.js";
import { buildStatsDashboardPayload } from "../../src/core/statsDashboardModel.js";
import type { StatsFileV1 } from "../../src/core/syncStatsStore.js";

function ev(partial: Partial<ActivityEvent> & Pick<ActivityEvent, "kind" | "relPath" | "machineName">): ActivityEvent {
  return {
    id: "i",
    at: new Date().toISOString(),
    workspaceId: "w",
    workspaceNote: "n",
    machineName: partial.machineName,
    provider: "onedrive",
    relPath: partial.relPath,
    kind: partial.kind,
  };
}

describe("statsDashboardModel", () => {
  it("aggregates push/pull per machine in 30d window", () => {
    const now = Date.now();
    const recent = new Date(now - 2 * 86_400_000).toISOString();
    const old = new Date(now - 40 * 86_400_000).toISOString();
    const events: ActivityEvent[] = [
      { ...ev({ kind: "push", relPath: "a.ts", machineName: "m1" }), at: recent },
      { ...ev({ kind: "pull", relPath: "a.ts", machineName: "m1" }), at: recent },
      { ...ev({ kind: "push", relPath: "b.ts", machineName: "m2" }), at: old },
    ];
    const stats: StatsFileV1 = {
      schema: 1,
      trafficMonthKey: "2099-01",
      bytesUploadedMonth: 1,
      bytesDownloadedMonth: 2,
      bytesSavedByCompressionMonth: 0,
    };
    const p = buildStatsDashboardPayload(events, stats, { monthlyLimitMB: 10, compressUploads: false });
    expect(p.pushCountMonth).toBe(1);
    expect(p.pullCountMonth).toBe(1);
    expect(p.pushPullByMachine.length).toBe(1);
    expect(p.pushPullByMachine[0]?.machine).toBe("m1");
    expect(p.pushPullByMachine[0]?.push).toBe(1);
    expect(p.pushPullByMachine[0]?.pull).toBe(1);
    expect(p.topFiles.some((t) => t.path === "a.ts")).toBe(true);
  });
});
