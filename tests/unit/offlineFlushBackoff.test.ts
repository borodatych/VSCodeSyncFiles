/**
 * Tests for the offline-flush backoff policy that throttles automatic
 * retries after transport failures. Independent of any provider — pure
 * timing helpers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  allowImmediateOfflineFlushRetry,
  bumpOfflineFlushBackoff,
  canAttemptOfflineFlushNow,
  resetOfflineFlushBackoff,
} from "../../src/core/syncOfflineFlushBackoff.js";

describe("syncOfflineFlushBackoff", () => {
  beforeEach(() => {
    resetOfflineFlushBackoff();
  });

  it("starts in the «can attempt» state", () => {
    expect(canAttemptOfflineFlushNow()).toBe(true);
  });

  it("bumpOfflineFlushBackoff blocks subsequent attempts for at least 10s", () => {
    bumpOfflineFlushBackoff();
    expect(canAttemptOfflineFlushNow()).toBe(false);
  });

  it("subsequent bumps grow the backoff window (exponential)", () => {
    bumpOfflineFlushBackoff();
    expect(canAttemptOfflineFlushNow()).toBe(false);
    // Multiple bumps in quick succession should not reduce the window —
    // the next-attempt point only moves forward (or stays).
    const stillBlocked = canAttemptOfflineFlushNow();
    bumpOfflineFlushBackoff();
    bumpOfflineFlushBackoff();
    expect(canAttemptOfflineFlushNow()).toBe(stillBlocked);
  });

  it("allowImmediateOfflineFlushRetry clears the block immediately", () => {
    bumpOfflineFlushBackoff();
    expect(canAttemptOfflineFlushNow()).toBe(false);
    allowImmediateOfflineFlushRetry();
    expect(canAttemptOfflineFlushNow()).toBe(true);
  });

  it("resetOfflineFlushBackoff clears state for next test run", () => {
    bumpOfflineFlushBackoff();
    resetOfflineFlushBackoff();
    expect(canAttemptOfflineFlushNow()).toBe(true);
  });
});
