import { describe, expect, it } from "vitest";
import {
  bucketBrowser,
  bucketFailureReason,
  bucketOs,
  toUsagePayload,
  type PasskeyTelemetryEvent,
} from "../../src/core/passkeyTelemetryEvents.js";

describe("bucketFailureReason", () => {
  it("preserves known reasons", () => {
    expect(bucketFailureReason("user_cancelled")).toBe("user_cancelled");
    expect(bucketFailureReason("auth_tag_failure")).toBe("auth_tag_failure");
    expect(bucketFailureReason("lockout")).toBe("lockout");
  });

  it("buckets unknown into 'unknown' (no PII leak)", () => {
    expect(bucketFailureReason("Error: ENOENT /home/alice/.config/foo")).toBe("unknown");
    expect(bucketFailureReason("WebAuthn: NotAllowedError 0x80004005")).toBe("unknown");
  });
});

describe("bucketBrowser / bucketOs", () => {
  it("buckets browser names, fallback Other", () => {
    expect(bucketBrowser("Chrome")).toBe("Chrome");
    expect(bucketBrowser("Brave")).toBe("Other");
    expect(bucketBrowser("")).toBe("Other");
  });

  it("buckets OS names, fallback Other", () => {
    expect(bucketOs("macOS")).toBe("macOS");
    expect(bucketOs("BSD")).toBe("Other");
  });
});

describe("toUsagePayload — enroll", () => {
  it("renders enroll_success with sanitised buckets", () => {
    const e: PasskeyTelemetryEvent = {
      kind: "enroll_success",
      credentialCount: 2,
      browser: "Chrome",
      os: "macOS",
    };
    const r = toUsagePayload(e);
    expect(r.name).toBe("vscodesync.passkey.enroll_success");
    expect(r.data).toEqual({ credentialCount: 2, browser: "Chrome", os: "macOS" });
  });

  it("buckets unknown browser/os labels in enroll_failure", () => {
    const e: PasskeyTelemetryEvent = {
      kind: "enroll_failure",
      reason: "platform_unavailable",
      browser: "Brave" as never,
      os: "BSD" as never,
    };
    const r = toUsagePayload(e);
    expect(r.data.browser).toBe("Other");
    expect(r.data.os).toBe("Other");
  });
});

describe("toUsagePayload — unlock", () => {
  it("renders unlock_success with latency", () => {
    const e: PasskeyTelemetryEvent = {
      kind: "unlock_success",
      credentialCount: 1,
      latencyMs: 432,
    };
    const r = toUsagePayload(e);
    expect(r.name).toBe("vscodesync.passkey.unlock_success");
    expect(r.data.latencyMs).toBe(432);
  });

  it("preserves null latency when not measured", () => {
    const e: PasskeyTelemetryEvent = {
      kind: "unlock_success",
      credentialCount: 1,
      latencyMs: null,
    };
    const r = toUsagePayload(e);
    expect(r.data.latencyMs).toBeNull();
  });

  it("clamps negative / NaN counters to 0", () => {
    const e: PasskeyTelemetryEvent = {
      kind: "unlock_success",
      credentialCount: -5,
      latencyMs: NaN,
    };
    const r = toUsagePayload(e);
    expect(r.data.credentialCount).toBe(0);
    expect(r.data.latencyMs).toBe(0);
  });

  it("buckets unknown unlock reason as 'unknown'", () => {
    const e: PasskeyTelemetryEvent = {
      kind: "unlock_failure",
      reason: "Error: NotAllowedError" as never,
      attemptsInWindow: 3,
    };
    const r = toUsagePayload(e);
    expect(r.data.reason).toBe("unknown");
    expect(r.data.attemptsInWindow).toBe(3);
  });
});

describe("toUsagePayload — removal / recovery / passphrase", () => {
  it("renders removal with primary flag", () => {
    const e: PasskeyTelemetryEvent = {
      kind: "removal",
      credentialCount: 0,
      removedPrimary: true,
    };
    const r = toUsagePayload(e);
    expect(r.name).toBe("vscodesync.passkey.removal");
    expect(r.data).toEqual({ credentialCount: 0, removedPrimary: true });
  });

  it("renders recovery_code_used", () => {
    const e: PasskeyTelemetryEvent = { kind: "recovery_code_used", remainingCodes: 4 };
    const r = toUsagePayload(e);
    expect(r.name).toBe("vscodesync.passkey.recovery_code_used");
    expect(r.data).toEqual({ remainingCodes: 4 });
  });

  it("renders passphrase_fallback_used with mode", () => {
    const e: PasskeyTelemetryEvent = {
      kind: "passphrase_fallback_used",
      mode: "unlock",
      attemptsInWindow: 1,
    };
    const r = toUsagePayload(e);
    expect(r.name).toBe("vscodesync.passkey.passphrase_fallback_used");
    expect(r.data).toEqual({ mode: "unlock", attemptsInWindow: 1 });
  });
});

describe("toUsagePayload — PII never leaks", () => {
  it("does not include any field outside the documented schema", () => {
    const e: PasskeyTelemetryEvent = {
      kind: "enroll_success",
      credentialCount: 1,
      browser: "Chrome",
      os: "Windows",
    };
    const r = toUsagePayload(e);
    expect(Object.keys(r.data).sort()).toEqual(["browser", "credentialCount", "os"]);
  });
});
