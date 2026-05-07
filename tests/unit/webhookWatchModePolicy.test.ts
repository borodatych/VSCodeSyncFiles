import { describe, expect, it } from "vitest";
import { shouldSuppressWatchPollingFromSilencePolicy } from "../../src/ui/webhookWatchModePolicy.js";

describe("webhookWatchModePolicy", () => {
  const t0 = 1_700_000_000_000;

  it("no suppression when webhooks off", () => {
    expect(
      shouldSuppressWatchPollingFromSilencePolicy({
        lifecycleActive: true,
        webhooksEnabled: false,
        fallbackAfterMinutes: 5,
        lastNotificationAtMs: t0,
        subscriptionActivatedAtMs: t0,
        nowMs: t0 + 60 * 60_000,
      }),
    ).toBe(false);
  });

  it("no suppression when lifecycle inactive", () => {
    expect(
      shouldSuppressWatchPollingFromSilencePolicy({
        lifecycleActive: false,
        webhooksEnabled: true,
        fallbackAfterMinutes: 5,
        lastNotificationAtMs: t0,
        subscriptionActivatedAtMs: t0,
        nowMs: t0 + 60 * 60_000,
      }),
    ).toBe(false);
  });

  it("always suppress when fallback minutes is 0", () => {
    expect(
      shouldSuppressWatchPollingFromSilencePolicy({
        lifecycleActive: true,
        webhooksEnabled: true,
        fallbackAfterMinutes: 0,
        lastNotificationAtMs: t0,
        subscriptionActivatedAtMs: t0,
        nowMs: t0 + 10_000_000,
      }),
    ).toBe(true);
  });

  it("suppresses during grace after activation", () => {
    expect(
      shouldSuppressWatchPollingFromSilencePolicy({
        lifecycleActive: true,
        webhooksEnabled: true,
        fallbackAfterMinutes: 5,
        lastNotificationAtMs: t0,
        subscriptionActivatedAtMs: t0,
        nowMs: t0 + 4 * 60_000,
      }),
    ).toBe(true);
  });

  it("stops suppressing after silence beyond threshold post-grace", () => {
    const activated = t0;
    const lastN = t0;
    expect(
      shouldSuppressWatchPollingFromSilencePolicy({
        lifecycleActive: true,
        webhooksEnabled: true,
        fallbackAfterMinutes: 5,
        lastNotificationAtMs: lastN,
        subscriptionActivatedAtMs: activated,
        nowMs: activated + 6 * 60_000,
      }),
    ).toBe(false);
  });

  it("suppresses when recent notification", () => {
    const now = t0 + 60 * 60_000;
    expect(
      shouldSuppressWatchPollingFromSilencePolicy({
        lifecycleActive: true,
        webhooksEnabled: true,
        fallbackAfterMinutes: 5,
        lastNotificationAtMs: now - 60_000,
        subscriptionActivatedAtMs: t0,
        nowMs: now,
      }),
    ).toBe(true);
  });
});
