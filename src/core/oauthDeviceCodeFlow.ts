/**
 * v2.20.3 — pure OAuth 2.0 Device Authorization Grant (RFC 8628) helpers.
 *
 * Driven by a caller that owns transport (so the same module can target
 * Microsoft / Google / Yandex / Dropbox by passing the right endpoints).
 * No `vscode`, no `node-fetch` — caller injects an HTTP client that
 * returns plain JSON values.
 *
 * Two helpers:
 *   - {@link parseDeviceAuthResponse} validates the device endpoint
 *     response (`device_code`, `user_code`, `verification_uri`, `expires_in`,
 *     `interval`).
 *   - {@link planDeviceCodePoll} is a state-driven decider: given the most
 *     recent `slow_down` / `authorization_pending` / explicit error, returns
 *     `{ action: "poll" | "wait_then_poll" | "stop"; nextDelayMs }`.
 *
 * The actual HTTP polling loop is the caller's responsibility — that lets
 * the same logic be exercised by unit tests without a real timer.
 */

export interface DeviceAuthResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** ms timestamp when device_code expires (computed from `expires_in`). */
  expiresAtMs: number;
  /** Initial interval between token polls. RFC default 5 s. */
  intervalMs: number;
  /** Optional URI carrying a pre-filled `user_code`. */
  verificationUriComplete?: string;
}

export type ParseDeviceAuthResult =
  | { ok: true; value: DeviceAuthResponse }
  | { ok: false; reason: ParseDeviceAuthRejection };

export type ParseDeviceAuthRejection =
  | "bad_root"
  | "missing_device_code"
  | "missing_user_code"
  | "missing_verification_uri"
  | "missing_expires_in"
  | "bad_interval";

const DEFAULT_INTERVAL_S = 5;

export function parseDeviceAuthResponse(
  raw: unknown,
  nowMs: number,
): ParseDeviceAuthResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "bad_root" };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.device_code !== "string" || o.device_code.length === 0) {
    return { ok: false, reason: "missing_device_code" };
  }
  if (typeof o.user_code !== "string" || o.user_code.length === 0) {
    return { ok: false, reason: "missing_user_code" };
  }
  if (typeof o.verification_uri !== "string" || o.verification_uri.length === 0) {
    return { ok: false, reason: "missing_verification_uri" };
  }
  if (typeof o.expires_in !== "number" || o.expires_in <= 0) {
    return { ok: false, reason: "missing_expires_in" };
  }
  let interval = DEFAULT_INTERVAL_S;
  if (o.interval !== undefined) {
    if (typeof o.interval !== "number" || o.interval <= 0) {
      return { ok: false, reason: "bad_interval" };
    }
    interval = o.interval;
  }
  const result: DeviceAuthResponse = {
    deviceCode: o.device_code,
    userCode: o.user_code,
    verificationUri: o.verification_uri,
    expiresAtMs: nowMs + o.expires_in * 1000,
    intervalMs: interval * 1000,
  };
  if (typeof o.verification_uri_complete === "string" && o.verification_uri_complete.length > 0) {
    result.verificationUriComplete = o.verification_uri_complete;
  }
  return { ok: true, value: result };
}

export type DeviceCodePollEvent =
  | { kind: "ok"; accessToken: string; refreshToken?: string }
  | { kind: "authorization_pending" }
  | { kind: "slow_down" }
  | { kind: "expired_token" }
  | { kind: "access_denied" }
  | { kind: "unknown_error"; error: string };

export type DeviceCodePollDecision =
  | { action: "poll"; delayMs: number }
  | { action: "stop"; reason: DeviceCodeStopReason };

export type DeviceCodeStopReason =
  | "ok"
  | "expired_token"
  | "access_denied"
  | "expires_at_passed"
  | "unknown_error"
  | "max_slow_down_reached";

export interface PlanDeviceCodePollOptions {
  baseDelayMs: number;
  /** Max additional ms added on each `slow_down`. RFC default +5 s. */
  slowDownStepMs?: number;
  /** Cap so a misbehaving server can't push us into "poll once an hour". */
  maxDelayMs?: number;
  /** When to give up after consecutive `slow_down`s. */
  maxConsecutiveSlowDowns?: number;
}

export interface PlanDeviceCodePollInput {
  event: DeviceCodePollEvent;
  /** Current cumulative delay (starts at `baseDelayMs`). */
  currentDelayMs: number;
  /** Number of consecutive `slow_down`s so far. */
  consecutiveSlowDowns: number;
  /** Wall-clock check vs. `expiresAtMs`. */
  nowMs: number;
  expiresAtMs: number;
}

const DEFAULT_SLOW_DOWN_STEP_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_SLOW_DOWNS = 6;

export function planDeviceCodePoll(
  input: PlanDeviceCodePollInput,
  options: PlanDeviceCodePollOptions,
): DeviceCodePollDecision {
  if (input.nowMs >= input.expiresAtMs) {
    return { action: "stop", reason: "expires_at_passed" };
  }
  switch (input.event.kind) {
    case "ok":
      return { action: "stop", reason: "ok" };
    case "expired_token":
      return { action: "stop", reason: "expired_token" };
    case "access_denied":
      return { action: "stop", reason: "access_denied" };
    case "unknown_error":
      return { action: "stop", reason: "unknown_error" };
    case "authorization_pending":
      return { action: "poll", delayMs: input.currentDelayMs };
    case "slow_down": {
      const max = options.maxConsecutiveSlowDowns ?? DEFAULT_MAX_SLOW_DOWNS;
      if (input.consecutiveSlowDowns + 1 >= max) {
        return { action: "stop", reason: "max_slow_down_reached" };
      }
      const step = options.slowDownStepMs ?? DEFAULT_SLOW_DOWN_STEP_MS;
      const cap = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
      return { action: "poll", delayMs: Math.min(cap, input.currentDelayMs + step) };
    }
  }
}
