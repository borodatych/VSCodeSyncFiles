import { describe, expect, it } from "vitest";
import { planSyncTickAction } from "../../src/core/syncTickPlanner.js";
import { parseSyncSchedule } from "../../src/core/syncSchedulePlanner.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60_000;

function schedule(raw: string) {
  const r = parseSyncSchedule(raw);
  if (!r.ok) throw new Error(`bad fixture: ${r.reason}`);
  return r.schedule;
}

describe("planSyncTickAction — guards", () => {
  it("waits with reason=disabled when the setting is off", () => {
    expect(
      planSyncTickAction({
        enabled: false,
        schedule: schedule("hourly"),
        lastRunMs: NOW - 2 * HOUR,
        nowMs: NOW,
      }),
    ).toEqual({ action: "wait", reason: "disabled", nextProbeMs: null });
  });

  it("waits with reason=no_schedule when schedule is null (parse failed)", () => {
    expect(
      planSyncTickAction({
        enabled: true,
        schedule: null,
        lastRunMs: NOW,
        nowMs: NOW,
      }),
    ).toEqual({ action: "wait", reason: "no_schedule", nextProbeMs: null });
  });
});

describe("planSyncTickAction — first run", () => {
  it("kicks an immediate sync when lastRunMs is null", () => {
    expect(
      planSyncTickAction({
        enabled: true,
        schedule: schedule("hourly"),
        lastRunMs: null,
        nowMs: NOW,
      }),
    ).toEqual({ action: "sync_now", reason: "first_run" });
  });
});

describe("planSyncTickAction — hourly cadence", () => {
  it("waits when less than an hour has elapsed", () => {
    const r = planSyncTickAction({
      enabled: true,
      schedule: schedule("hourly"),
      lastRunMs: NOW - 30 * 60_000,
      nowMs: NOW,
    });
    expect(r.action).toBe("wait");
    if (r.action === "wait") {
      expect(r.reason).toBe("schedule_pending");
      expect(r.nextProbeMs).toBe(NOW + 5 * 60_000);
    }
  });

  it("syncs once the hour has elapsed", () => {
    expect(
      planSyncTickAction({
        enabled: true,
        schedule: schedule("hourly"),
        lastRunMs: NOW - HOUR,
        nowMs: NOW,
      }),
    ).toEqual({ action: "sync_now", reason: "schedule_due" });
  });
});

describe("planSyncTickAction — defaultProbeMs override", () => {
  it("uses the caller-supplied probe interval", () => {
    const r = planSyncTickAction({
      enabled: true,
      schedule: schedule("hourly"),
      lastRunMs: NOW - 30 * 60_000,
      nowMs: NOW,
      defaultProbeMs: 60_000,
    });
    expect(r.action).toBe("wait");
    if (r.action === "wait") expect(r.nextProbeMs).toBe(NOW + 60_000);
  });
});

describe("planSyncTickAction — daily slot", () => {
  it("syncs when current time has crossed the daily slot since last run", () => {
    const startOfDay = new Date(NOW);
    startOfDay.setHours(0, 0, 0, 0);
    const slotMs = startOfDay.getTime() + 9 * HOUR;
    expect(
      planSyncTickAction({
        enabled: true,
        schedule: schedule("daily 09:00"),
        lastRunMs: slotMs - HOUR,
        nowMs: slotMs + HOUR,
      }),
    ).toEqual({ action: "sync_now", reason: "schedule_due" });
  });
});
