import { describe, expect, it } from "vitest";
import { dispatchScheduledJobs } from "../../src/core/scheduledJobsDispatcher.js";
import { parseSyncSchedule } from "../../src/core/syncSchedulePlanner.js";
import { EMPTY_SCHEDULE, type LearnedSchedule } from "../../src/core/autoPauseLearner.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function syncSchedule() {
  const r = parseSyncSchedule("hourly");
  if (!r.ok) throw new Error("bad fixture");
  return r.schedule;
}

function quietSchedule(quietHours: number[]): LearnedSchedule {
  const hourActive = new Array<boolean>(24).fill(true);
  for (const h of quietHours) hourActive[h] = false;
  return {
    hourActive,
    countsByHour: new Array(24).fill(0) as number[],
    meanPerHour: 100,
    quietHourRatio: 0.25,
  };
}

function utcHour(h: number): number {
  return Date.UTC(2026, 0, 1, h, 0, 0);
}

describe("dispatchScheduledJobs — happy path", () => {
  it("emits sync_now when sync schedule is due and no other gates fire", () => {
    const r = dispatchScheduledJobs({
      syncTick: {
        enabled: true,
        schedule: syncSchedule(),
        lastRunMs: NOW - HOUR,
        nowMs: NOW,
      },
      backupVerifyTick: {
        enabled: false,
        lastRunMs: null,
        lastSeverity: null,
        nowMs: NOW,
        intervalMs: DAY,
      },
      autoPauseTick: {
        schedule: EMPTY_SCHEDULE,
        enabled: true,
        nowMs: NOW,
        timezoneOffsetMinutes: 0,
      },
    });
    expect(r.actions).toEqual([{ kind: "sync_now", reason: "schedule_due" }]);
  });

  it("emits backup_verify_now when verify is due (parallel to sync wait)", () => {
    const r = dispatchScheduledJobs({
      syncTick: {
        enabled: true,
        schedule: syncSchedule(),
        lastRunMs: NOW,
        nowMs: NOW,
      },
      backupVerifyTick: {
        enabled: true,
        lastRunMs: NOW - DAY,
        lastSeverity: "ok",
        nowMs: NOW,
        intervalMs: DAY,
      },
      autoPauseTick: {
        schedule: EMPTY_SCHEDULE,
        enabled: true,
        nowMs: NOW,
        timezoneOffsetMinutes: 0,
      },
    });
    expect(r.actions).toEqual([{ kind: "backup_verify_now", reason: "interval_due" }]);
  });
});

describe("dispatchScheduledJobs — auto-pause gating", () => {
  it("emits auto_pause and suppresses sync_now in the same tick", () => {
    const r = dispatchScheduledJobs({
      syncTick: {
        enabled: true,
        schedule: syncSchedule(),
        lastRunMs: NOW - HOUR,
        nowMs: utcHour(3),
      },
      backupVerifyTick: {
        enabled: false,
        lastRunMs: null,
        lastSeverity: null,
        nowMs: utcHour(3),
        intervalMs: DAY,
      },
      autoPauseTick: {
        schedule: quietSchedule([2, 3, 4]),
        enabled: true,
        nowMs: utcHour(3),
        timezoneOffsetMinutes: 0,
      },
    });
    expect(r.actions).toContainEqual({
      kind: "auto_pause",
      reason: "quiet_hour",
      resumesAtMs: utcHour(5),
    });
    // sync was due but should be suppressed.
    expect(r.actions.find((a) => a.kind === "sync_now")).toBeUndefined();
  });

  it("still emits backup_verify_now while auto-paused (verify is read-only)", () => {
    const r = dispatchScheduledJobs({
      syncTick: {
        enabled: false,
        schedule: null,
        lastRunMs: null,
        nowMs: utcHour(3),
      },
      backupVerifyTick: {
        enabled: true,
        lastRunMs: null,
        lastSeverity: null,
        nowMs: utcHour(3),
        intervalMs: DAY,
      },
      autoPauseTick: {
        schedule: quietSchedule([2, 3, 4]),
        enabled: true,
        nowMs: utcHour(3),
        timezoneOffsetMinutes: 0,
      },
    });
    const kinds = r.actions.map((a) => a.kind);
    expect(kinds).toContain("auto_pause");
    expect(kinds).toContain("backup_verify_now");
  });
});

describe("dispatchScheduledJobs — nextProbeMs aggregation", () => {
  it("returns the earliest non-null next-probe across planners", () => {
    const r = dispatchScheduledJobs({
      syncTick: {
        enabled: true,
        schedule: syncSchedule(),
        lastRunMs: NOW - 30 * 60_000,
        nowMs: NOW,
        defaultProbeMs: 60_000,
      },
      backupVerifyTick: {
        enabled: true,
        lastRunMs: NOW - 12 * HOUR,
        lastSeverity: "ok",
        nowMs: NOW,
        intervalMs: DAY,
      },
      autoPauseTick: {
        schedule: EMPTY_SCHEDULE,
        enabled: true,
        nowMs: NOW,
        timezoneOffsetMinutes: 0,
      },
    });
    expect(r.nextProbeMs).toBe(NOW + 60_000);
  });

  it("returns null when nothing wants a future probe", () => {
    const r = dispatchScheduledJobs({
      syncTick: {
        enabled: false,
        schedule: null,
        lastRunMs: null,
        nowMs: NOW,
      },
      backupVerifyTick: {
        enabled: false,
        lastRunMs: null,
        lastSeverity: null,
        nowMs: NOW,
        intervalMs: DAY,
      },
      autoPauseTick: {
        schedule: EMPTY_SCHEDULE,
        enabled: false,
        nowMs: NOW,
        timezoneOffsetMinutes: 0,
      },
    });
    expect(r.nextProbeMs).toBeNull();
  });
});

describe("dispatchScheduledJobs — emits ordered actions", () => {
  it("orders auto_pause before backup_verify_now before sync_now", () => {
    const r = dispatchScheduledJobs({
      syncTick: {
        enabled: true,
        schedule: syncSchedule(),
        lastRunMs: NOW - HOUR,
        nowMs: utcHour(10),
      },
      backupVerifyTick: {
        enabled: true,
        lastRunMs: utcHour(10) - DAY,
        lastSeverity: "ok",
        nowMs: utcHour(10),
        intervalMs: DAY,
      },
      autoPauseTick: {
        schedule: EMPTY_SCHEDULE,
        enabled: true,
        nowMs: utcHour(10),
        timezoneOffsetMinutes: 0,
      },
    });
    // No auto-pause this tick, but order of remaining is verify → sync.
    expect(r.actions.map((a) => a.kind)).toEqual(["backup_verify_now", "sync_now"]);
  });
});

describe("dispatchScheduledJobs — details surface", () => {
  it("returns sub-results for telemetry without recomputing", () => {
    const r = dispatchScheduledJobs({
      syncTick: {
        enabled: true,
        schedule: syncSchedule(),
        lastRunMs: null,
        nowMs: NOW,
      },
      backupVerifyTick: {
        enabled: true,
        lastRunMs: null,
        lastSeverity: null,
        nowMs: NOW,
        intervalMs: DAY,
      },
      autoPauseTick: {
        schedule: EMPTY_SCHEDULE,
        enabled: true,
        nowMs: NOW,
        timezoneOffsetMinutes: 0,
      },
    });
    expect(r.details.sync.action).toBe("sync_now");
    expect(r.details.backupVerify.action).toBe("verify_now");
    expect(r.details.autoPause.paused).toBe(false);
  });
});
