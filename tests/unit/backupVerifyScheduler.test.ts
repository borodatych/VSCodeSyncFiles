import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERIFY_INTERVAL_MS,
  planBackupVerifyTick,
} from "../../src/core/backupVerifyScheduler.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe("planBackupVerifyTick — guards", () => {
  it("waits with reason=disabled when the setting is off", () => {
    expect(
      planBackupVerifyTick({
        enabled: false,
        lastRunMs: null,
        lastSeverity: null,
        nowMs: NOW,
        intervalMs: DEFAULT_VERIFY_INTERVAL_MS,
      }),
    ).toEqual({ action: "wait", reason: "disabled", nextDueMs: null });
  });

  it("verifies immediately on the first run regardless of interval", () => {
    expect(
      planBackupVerifyTick({
        enabled: true,
        lastRunMs: null,
        lastSeverity: null,
        nowMs: NOW,
        intervalMs: DEFAULT_VERIFY_INTERVAL_MS,
      }),
    ).toEqual({ action: "verify_now", reason: "first_run" });
  });
});

describe("planBackupVerifyTick — interval cadence", () => {
  it("waits when the interval has not elapsed since last run", () => {
    const r = planBackupVerifyTick({
      enabled: true,
      lastRunMs: NOW - 2 * HOUR,
      lastSeverity: "ok",
      nowMs: NOW,
      intervalMs: DAY,
    });
    expect(r).toEqual({
      action: "wait",
      reason: "interval_pending",
      nextDueMs: NOW - 2 * HOUR + DAY,
    });
  });

  it("verifies when the full interval has elapsed and last verdict was ok", () => {
    expect(
      planBackupVerifyTick({
        enabled: true,
        lastRunMs: NOW - DAY,
        lastSeverity: "ok",
        nowMs: NOW,
        intervalMs: DAY,
      }),
    ).toEqual({ action: "verify_now", reason: "interval_due" });
  });
});

describe("planBackupVerifyTick — broken retry backoff", () => {
  it("uses the shortened backoff when the last severity was 'broken'", () => {
    // Last run 7h ago, normal interval 24h, broken backoff = 6h → due now.
    const r = planBackupVerifyTick({
      enabled: true,
      lastRunMs: NOW - 7 * HOUR,
      lastSeverity: "broken",
      nowMs: NOW,
      intervalMs: DAY,
    });
    expect(r).toEqual({ action: "verify_now", reason: "broken_retry" });
  });

  it("still waits during the backoff window", () => {
    const r = planBackupVerifyTick({
      enabled: true,
      lastRunMs: NOW - HOUR,
      lastSeverity: "broken",
      nowMs: NOW,
      intervalMs: DAY,
    });
    expect(r.action).toBe("wait");
    if (r.action === "wait") {
      expect(r.reason).toBe("interval_pending");
      expect(r.nextDueMs).toBe(NOW - HOUR + DAY / 4);
    }
  });

  it("respects a caller-supplied brokenBackoffMs", () => {
    const r = planBackupVerifyTick({
      enabled: true,
      lastRunMs: NOW - 30 * 60_000,
      lastSeverity: "broken",
      nowMs: NOW,
      intervalMs: DAY,
      brokenBackoffMs: 60 * 60_000,
    });
    expect(r.action).toBe("wait");
    if (r.action === "wait") {
      expect(r.nextDueMs).toBe(NOW - 30 * 60_000 + 60 * 60_000);
    }
  });
});

describe("planBackupVerifyTick — drift severity", () => {
  it("treats 'drift' / 'stale' the same as 'ok' for cadence (interval, not backoff)", () => {
    const r = planBackupVerifyTick({
      enabled: true,
      lastRunMs: NOW - 4 * HOUR,
      lastSeverity: "drift",
      nowMs: NOW,
      intervalMs: DAY,
    });
    expect(r).toEqual({
      action: "wait",
      reason: "interval_pending",
      nextDueMs: NOW - 4 * HOUR + DAY,
    });
  });
});
