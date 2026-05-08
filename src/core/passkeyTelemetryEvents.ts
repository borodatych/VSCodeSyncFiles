/**
 * v2.2.6 — pure event-shape + sanitiser for the WebAuthn / FIDO2 unlock
 * pipeline. Surfaces:
 *
 *   - Discriminated-union `PasskeyTelemetryEvent` for every relevant
 *     interaction (enroll / unlock / removal / recovery code use).
 *   - `toUsagePayload(event)` → `{ name, data }` ready for the existing
 *     `vscode.TelemetryLogger.logUsage(...)` call. The sanitiser scrubs
 *     credential ids, raw user-agent strings, and any free-form text — only
 *     bucketed enums + numeric counters survive.
 *
 * No `vscode` import. No PII fields are ever produced by this module.
 *
 * Failure-reason taxonomy is intentionally fixed: anything not in the
 * recognised set is bucketed as `"unknown"` so we never accidentally leak
 * exception messages.
 */

export type PasskeyEventKind =
  | "enroll_success"
  | "enroll_failure"
  | "unlock_success"
  | "unlock_failure"
  | "removal"
  | "recovery_code_used"
  | "passphrase_fallback_used";

export type PasskeyFailureReason =
  | "user_cancelled"
  | "no_credentials_available"
  | "credential_not_found"
  | "auth_tag_failure"
  | "platform_unavailable"
  | "rate_limited"
  | "lockout"
  | "unknown";

export type PasskeyTelemetryEvent =
  | {
      kind: "enroll_success";
      /** Number of credentials in the registry AFTER this enrollment. */
      credentialCount: number;
      /** Coarse browser bucket from `parseDeviceUserAgent`. */
      browser: PasskeyBrowserBucket;
      os: PasskeyOsBucket;
    }
  | {
      kind: "enroll_failure";
      reason: PasskeyFailureReason;
      browser: PasskeyBrowserBucket;
      os: PasskeyOsBucket;
    }
  | {
      kind: "unlock_success";
      credentialCount: number;
      /** Wall-clock ms between `prompt` and `unlock`. Null when not measured. */
      latencyMs: number | null;
    }
  | {
      kind: "unlock_failure";
      reason: PasskeyFailureReason;
      /** Number of consecutive failures in this lockout window. */
      attemptsInWindow: number;
    }
  | {
      kind: "removal";
      /** Number of credentials in the registry AFTER this removal. */
      credentialCount: number;
      removedPrimary: boolean;
    }
  | {
      kind: "recovery_code_used";
      /** Number of recovery codes still unused after this consumption. */
      remainingCodes: number;
    }
  | {
      kind: "passphrase_fallback_used";
      mode: "enroll" | "unlock" | "recover";
      attemptsInWindow: number;
    };

export type PasskeyBrowserBucket =
  | "Chrome"
  | "Firefox"
  | "Safari"
  | "Edge"
  | "Other";
export type PasskeyOsBucket =
  | "Windows"
  | "macOS"
  | "Linux"
  | "iOS"
  | "Android"
  | "Other";

export interface PasskeyTelemetryUsagePayload {
  /** Stable event name suitable for `logger.logUsage(name, data)`. */
  name: string;
  /** Sanitised data object — only enums, booleans, and bounded numerics. */
  data: Record<string, string | number | boolean | null>;
}

const KNOWN_FAILURE_REASONS: ReadonlySet<string> = new Set<PasskeyFailureReason>([
  "user_cancelled",
  "no_credentials_available",
  "credential_not_found",
  "auth_tag_failure",
  "platform_unavailable",
  "rate_limited",
  "lockout",
  "unknown",
]);

const KNOWN_BROWSER_BUCKETS: ReadonlySet<string> = new Set<PasskeyBrowserBucket>([
  "Chrome",
  "Firefox",
  "Safari",
  "Edge",
  "Other",
]);

const KNOWN_OS_BUCKETS: ReadonlySet<string> = new Set<PasskeyOsBucket>([
  "Windows",
  "macOS",
  "Linux",
  "iOS",
  "Android",
  "Other",
]);

/** Bucket an arbitrary string into the failure taxonomy. Anything not
 *  recognised becomes `"unknown"`. */
export function bucketFailureReason(raw: string): PasskeyFailureReason {
  return (KNOWN_FAILURE_REASONS.has(raw) ? raw : "unknown") as PasskeyFailureReason;
}

export function bucketBrowser(raw: string): PasskeyBrowserBucket {
  return (KNOWN_BROWSER_BUCKETS.has(raw) ? raw : "Other") as PasskeyBrowserBucket;
}

export function bucketOs(raw: string): PasskeyOsBucket {
  return (KNOWN_OS_BUCKETS.has(raw) ? raw : "Other") as PasskeyOsBucket;
}

/** Render an event into a logger-ready payload. The `name` is namespaced
 *  under `vscodesync.passkey.<kind>` so dashboards can filter cleanly. */
export function toUsagePayload(event: PasskeyTelemetryEvent): PasskeyTelemetryUsagePayload {
  const name = `vscodesync.passkey.${event.kind}`;
  switch (event.kind) {
    case "enroll_success":
      return {
        name,
        data: {
          credentialCount: clampNonNeg(event.credentialCount),
          browser: bucketBrowser(event.browser),
          os: bucketOs(event.os),
        },
      };
    case "enroll_failure":
      return {
        name,
        data: {
          reason: bucketFailureReason(event.reason),
          browser: bucketBrowser(event.browser),
          os: bucketOs(event.os),
        },
      };
    case "unlock_success":
      return {
        name,
        data: {
          credentialCount: clampNonNeg(event.credentialCount),
          latencyMs: event.latencyMs === null ? null : clampNonNeg(event.latencyMs),
        },
      };
    case "unlock_failure":
      return {
        name,
        data: {
          reason: bucketFailureReason(event.reason),
          attemptsInWindow: clampNonNeg(event.attemptsInWindow),
        },
      };
    case "removal":
      return {
        name,
        data: {
          credentialCount: clampNonNeg(event.credentialCount),
          removedPrimary: event.removedPrimary,
        },
      };
    case "recovery_code_used":
      return {
        name,
        data: { remainingCodes: clampNonNeg(event.remainingCodes) },
      };
    case "passphrase_fallback_used":
      return {
        name,
        data: {
          mode: event.mode,
          attemptsInWindow: clampNonNeg(event.attemptsInWindow),
        },
      };
  }
}

function clampNonNeg(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}
