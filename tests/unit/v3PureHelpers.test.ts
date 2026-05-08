import { describe, expect, it } from "vitest";
import {
  createQuotaTracker,
  PROVIDER_DAILY_LIMITS,
  QUOTA_AUTO_PAUSE_RATIO,
  QUOTA_CRITICAL_RATIO,
  QUOTA_WARNING_RATIO,
} from "../../src/core/quotaTracker.js";
import { buildShareLink, parseShareLink } from "../../src/core/shareLink.js";
import {
  EMPTY_SCHEDULE,
  isQuietHour,
  learnAutoPauseSchedule,
} from "../../src/core/autoPauseLearner.js";
import {
  evaluateSelectiveSync,
  parseSelectiveSyncFile,
} from "../../src/core/selectiveSyncFilter.js";
import { planKeyRotation } from "../../src/core/keyRotationPlan.js";

describe("quotaTracker — recordCall + snapshot", () => {
  it("counts calls inside the rolling window only", () => {
    const t = createQuotaTracker({ windowMs: 1_000 });
    t.recordCall("gdrive", 100);
    t.recordCall("gdrive", 500);
    t.recordCall("gdrive", 1_500); // newer
    const snap = t.snapshot("gdrive", 1_500);
    expect(snap.callsInWindow).toBe(2); // 500 + 1500 are within last 1s
  });

  it("classifies severity using the warning / critical / auto_pause thresholds", () => {
    const customLimit = 100;
    const t = createQuotaTracker({
      windowMs: 1_000_000,
      overrideLimits: { gdrive: customLimit },
    });
    for (let i = 0; i < 71; i++) t.recordCall("gdrive", 1000 + i);
    const warn = t.snapshot("gdrive", 1100);
    expect(warn.ratio).toBeGreaterThanOrEqual(QUOTA_WARNING_RATIO);
    expect(warn.severity).toBe("warning");

    for (let i = 0; i < 25; i++) t.recordCall("gdrive", 1100 + i);
    const crit = t.snapshot("gdrive", 1200);
    expect(crit.severity === "critical" || crit.severity === "auto_pause").toBe(true);

    for (let i = 0; i < 10; i++) t.recordCall("gdrive", 1200 + i);
    const ap = t.snapshot("gdrive", 1300);
    expect(ap.severity).toBe("auto_pause");
  });

  it("returns severity 'ok' for providers without a known limit", () => {
    const t = createQuotaTracker();
    t.recordCall("onedrive", 1);
    const snap = t.snapshot("onedrive", 2);
    expect(PROVIDER_DAILY_LIMITS.onedrive ?? null).toBe(null);
    expect(snap.severity).toBe("ok");
  });

  it("snapshotAll returns one entry per provider that has had calls", () => {
    const t = createQuotaTracker();
    t.recordCall("gdrive", 1);
    t.recordCall("yandex", 1);
    const all = t.snapshotAll(2);
    expect(all.map((s) => s.provider).sort()).toEqual(["gdrive", "yandex"]);
  });

  it("threshold constants are well-ordered", () => {
    expect(QUOTA_WARNING_RATIO).toBeLessThan(QUOTA_CRITICAL_RATIO);
    expect(QUOTA_CRITICAL_RATIO).toBeLessThan(QUOTA_AUTO_PAUSE_RATIO);
  });
});

describe("shareLink — buildShareLink + parseShareLink", () => {
  it("round-trips workspaceId + snapshotName", () => {
    const url = buildShareLink({ workspaceId: "ws-abc123", snapshotName: "v1.snap" });
    const r = parseShareLink(url);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.workspaceId).toBe("ws-abc123");
      expect(r.payload.snapshotName).toBe("v1.snap");
    }
  });

  it("includes pwd hash when provided and rejects bad hash format", () => {
    const pwd = "a".repeat(64);
    const url = buildShareLink({
      workspaceId: "ws-abc1",
      snapshotName: "s",
      passwordHashHex: pwd,
    });
    const r = parseShareLink(url);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.passwordHashHex).toBe(pwd);

    expect(() =>
      buildShareLink({
        workspaceId: "ws-abc1",
        snapshotName: "s",
        passwordHashHex: "not-hex",
      }),
    ).toThrow(/64-char hex/);
  });

  it("rejects expired share links", () => {
    const past = Date.now() - 10_000;
    const url = buildShareLink({
      workspaceId: "ws-abc1",
      snapshotName: "s",
      expiresAtMs: past,
    });
    const r = parseShareLink(url, Date.now());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("rejects mismatched URL prefix", () => {
    const r = parseShareLink("https://example.com/share?workspace=ws-abc1&snapshot=s");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_path");
  });

  it("rejects bad workspace id (path-traversal etc.)", () => {
    expect(() =>
      buildShareLink({ workspaceId: "../escape", snapshotName: "s" }),
    ).toThrow(/invalid workspaceId/);
  });
});

describe("autoPauseLearner — learnAutoPauseSchedule", () => {
  it("returns EMPTY_SCHEDULE when input is below minEvents", () => {
    const r = learnAutoPauseSchedule([1, 2, 3], { minEvents: 100 });
    expect(r.hourActive).toEqual(EMPTY_SCHEDULE.hourActive);
    expect(r.meanPerHour).toBe(0);
  });

  it("classifies obvious quiet hours when given enough events", () => {
    // 1000 events all at hour 14 in UTC.
    const ts: number[] = [];
    for (let i = 0; i < 1000; i++) {
      ts.push(Date.UTC(2026, 0, 1, 14, i % 60, 0));
    }
    const r = learnAutoPauseSchedule(ts, { minEvents: 100, timezoneOffsetMinutes: 0 });
    // Hour 14 is way above mean × 0.25 → active.
    expect(r.hourActive[14]).toBe(true);
    // Hour 0 has zero events → quiet.
    expect(r.hourActive[0]).toBe(false);
  });

  it("isQuietHour respects the schedule", () => {
    const schedule = { ...EMPTY_SCHEDULE, hourActive: new Array(24).fill(false) as boolean[] };
    schedule.hourActive[10] = true;
    expect(isQuietHour(schedule, Date.UTC(2026, 0, 1, 10, 0, 0), 0)).toBe(false);
    expect(isQuietHour(schedule, Date.UTC(2026, 0, 1, 11, 0, 0), 0)).toBe(true);
  });
});

describe("selectiveSyncFilter — evaluateSelectiveSync", () => {
  it("all-tracked passes through", () => {
    expect(evaluateSelectiveSync("anything.txt", { mode: "all-tracked", patterns: [] })).toBe(true);
  });

  it("include-list matches single-segment glob", () => {
    expect(
      evaluateSelectiveSync("docs/readme.md", {
        mode: "include-list",
        patterns: ["docs/*.md"],
      }),
    ).toBe(true);
    expect(
      evaluateSelectiveSync("src/x.ts", {
        mode: "include-list",
        patterns: ["docs/*.md"],
      }),
    ).toBe(false);
  });

  it("** matches across slashes", () => {
    expect(
      evaluateSelectiveSync("a/b/c/file.ts", {
        mode: "include-list",
        patterns: ["**/file.ts"],
      }),
    ).toBe(true);
  });

  it("trailing slash matches all paths under directory", () => {
    expect(
      evaluateSelectiveSync("secrets/key.pem", {
        mode: "exclude-list",
        patterns: ["secrets/"],
      }),
    ).toBe(false);
    expect(
      evaluateSelectiveSync("public/x.txt", {
        mode: "exclude-list",
        patterns: ["secrets/"],
      }),
    ).toBe(true);
  });

  it("parseSelectiveSyncFile strips comments and blank lines", () => {
    expect(
      parseSelectiveSyncFile(`
        # comment
        node_modules/

        src/**/*.ts
      `),
    ).toEqual(["node_modules/", "src/**/*.ts"]);
  });
});

describe("keyRotationPlan — planKeyRotation", () => {
  it("packs items into batches respecting size + count caps", () => {
    const items = [
      { workspaceId: "w1", relPath: "a", sizeBytes: 10 * 1024 * 1024 },
      { workspaceId: "w1", relPath: "b", sizeBytes: 30 * 1024 * 1024 },
      { workspaceId: "w1", relPath: "c", sizeBytes: 20 * 1024 * 1024 },
      { workspaceId: "w2", relPath: "d", sizeBytes: 5 * 1024 * 1024 },
    ];
    const plan = planKeyRotation(items, {
      maxBytesPerBatch: 40 * 1024 * 1024,
      maxFilesPerBatch: 10,
    });
    expect(plan.totalFiles).toBe(4);
    expect(plan.batches.length).toBeGreaterThanOrEqual(2);
    for (const b of plan.batches) {
      expect(b.totalBytes).toBeLessThanOrEqual(40 * 1024 * 1024);
    }
  });

  it("excludes done items from batches but counts them in totalBytes", () => {
    const items = [
      { workspaceId: "w1", relPath: "a", sizeBytes: 5, done: true },
      { workspaceId: "w1", relPath: "b", sizeBytes: 7 },
    ];
    const plan = planKeyRotation(items);
    expect(plan.totalFiles).toBe(2);
    expect(plan.totalBytes).toBe(12);
    expect(plan.remainingFiles).toBe(1);
    expect(plan.remainingBytes).toBe(7);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]?.items[0]?.relPath).toBe("b");
  });

  it("orders items deterministically by workspaceId then relPath", () => {
    const items = [
      { workspaceId: "w2", relPath: "z", sizeBytes: 1 },
      { workspaceId: "w1", relPath: "z", sizeBytes: 1 },
      { workspaceId: "w1", relPath: "a", sizeBytes: 1 },
    ];
    const plan = planKeyRotation(items);
    const order = plan.batches[0]?.items.map((i) => `${i.workspaceId}:${i.relPath}`);
    expect(order).toEqual(["w1:a", "w1:z", "w2:z"]);
  });
});
