/**
 * Tests for the OAuth Device Code helpers (RFC 8628). Pure unit tests —
 * no real HTTP, no timers.
 */
import { describe, it, expect } from "vitest";
import {
  parseDeviceAuthResponse,
  planDeviceCodePoll,
  type DeviceCodePollEvent,
} from "../../src/core/oauthDeviceCodeFlow.js";

const NOW = 1_700_000_000_000;
const ONE_MIN = 60_000;

describe("parseDeviceAuthResponse", () => {
  it("accepts a minimal valid response", () => {
    const r = parseDeviceAuthResponse(
      {
        device_code: "ABCDEF",
        user_code: "WDJB-MJHT",
        verification_uri: "https://example.com/device",
        expires_in: 600,
      },
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.deviceCode).toBe("ABCDEF");
      expect(r.value.userCode).toBe("WDJB-MJHT");
      expect(r.value.intervalMs).toBe(5_000); // default
      expect(r.value.expiresAtMs).toBe(NOW + 600_000);
    }
  });

  it("respects custom interval", () => {
    const r = parseDeviceAuthResponse(
      {
        device_code: "x",
        user_code: "y",
        verification_uri: "https://e/d",
        expires_in: 60,
        interval: 7,
      },
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.intervalMs).toBe(7_000);
  });

  it("rejects when device_code missing", () => {
    const r = parseDeviceAuthResponse(
      { user_code: "y", verification_uri: "u", expires_in: 60 },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_device_code");
  });

  it("rejects bad interval", () => {
    const r = parseDeviceAuthResponse(
      { device_code: "x", user_code: "y", verification_uri: "u", expires_in: 60, interval: -1 },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_interval");
  });

  it("rejects non-object root", () => {
    expect(parseDeviceAuthResponse(null, NOW).ok).toBe(false);
    expect(parseDeviceAuthResponse([], NOW).ok).toBe(false);
    expect(parseDeviceAuthResponse("x", NOW).ok).toBe(false);
  });
});

describe("planDeviceCodePoll", () => {
  const base = { baseDelayMs: 5_000 };
  const expiresAtMs = NOW + 10 * ONE_MIN;

  function call(event: DeviceCodePollEvent, override: Partial<Parameters<typeof planDeviceCodePoll>[0]> = {}) {
    return planDeviceCodePoll(
      {
        event,
        currentDelayMs: 5_000,
        consecutiveSlowDowns: 0,
        nowMs: NOW,
        expiresAtMs,
        ...override,
      },
      base,
    );
  }

  it("ok → stop with reason ok", () => {
    expect(call({ kind: "ok", accessToken: "T" })).toEqual({ action: "stop", reason: "ok" });
  });

  it("authorization_pending → poll with current delay", () => {
    expect(call({ kind: "authorization_pending" })).toEqual({ action: "poll", delayMs: 5_000 });
  });

  it("slow_down → poll with bumped delay capped at maxDelayMs", () => {
    const r = call({ kind: "slow_down" }, { currentDelayMs: 28_000 });
    expect(r.action).toBe("poll");
    if (r.action === "poll") expect(r.delayMs).toBe(30_000); // capped
  });

  it("after maxConsecutiveSlowDowns it stops", () => {
    const r = call({ kind: "slow_down" }, { consecutiveSlowDowns: 5 });
    expect(r).toEqual({ action: "stop", reason: "max_slow_down_reached" });
  });

  it("expired_token → stop", () => {
    expect(call({ kind: "expired_token" })).toEqual({ action: "stop", reason: "expired_token" });
  });

  it("access_denied → stop", () => {
    expect(call({ kind: "access_denied" })).toEqual({ action: "stop", reason: "access_denied" });
  });

  it("expires_at_passed wins over event kind", () => {
    expect(
      planDeviceCodePoll(
        {
          event: { kind: "authorization_pending" },
          currentDelayMs: 5_000,
          consecutiveSlowDowns: 0,
          nowMs: NOW + 11 * ONE_MIN,
          expiresAtMs,
        },
        base,
      ),
    ).toEqual({ action: "stop", reason: "expires_at_passed" });
  });

  it("unknown_error → stop with reason unknown_error", () => {
    expect(call({ kind: "unknown_error", error: "weird" })).toEqual({
      action: "stop",
      reason: "unknown_error",
    });
  });
});
