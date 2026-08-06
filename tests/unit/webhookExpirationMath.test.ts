/**
 * Tests for the pure webhook-subscription expiration / reconcile helpers.
 */
import { describe, it, expect } from "vitest";
import {
  SUBSCRIPTION_RENEW_SLACK_MS,
  SUBSCRIPTION_VALID_SLACK_MS,
  isNearOrPastExpiration,
  reconcileSubscription,
} from "../../src/core/webhookExpirationMath.js";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

describe("isNearOrPastExpiration", () => {
  it("true for undefined / empty expiration (fail-closed)", () => {
    expect(isNearOrPastExpiration(undefined, 1000, NOW)).toBe(true);
    expect(isNearOrPastExpiration("", 1000, NOW)).toBe(true);
  });

  it("true for unparseable expiration (fail-closed)", () => {
    expect(isNearOrPastExpiration("not-a-date", 1000, NOW)).toBe(true);
  });

  it("true for past expiration", () => {
    const past = new Date(NOW - 60_000).toISOString();
    expect(isNearOrPastExpiration(past, 1000, NOW)).toBe(true);
  });

  it("true when within slack window", () => {
    const soon = new Date(NOW + 60_000).toISOString();
    expect(isNearOrPastExpiration(soon, 120_000, NOW)).toBe(true);
  });

  it("false when far enough in the future", () => {
    const far = new Date(NOW + 24 * 3600_000).toISOString();
    expect(isNearOrPastExpiration(far, 1000, NOW)).toBe(false);
  });

  it("default constants align with live lifecycle code", () => {
    expect(SUBSCRIPTION_VALID_SLACK_MS).toBe(120_000);
    expect(SUBSCRIPTION_RENEW_SLACK_MS).toBe(20 * 60_000);
  });
});

describe("reconcileSubscription", () => {
  const url = "https://smee.io/abc";
  const futureExp = new Date(NOW + 60 * 60_000).toISOString();
  const inRenewWindow = new Date(NOW + 10 * 60_000).toISOString();
  const past = new Date(NOW - 60_000).toISOString();

  it("create when no existing subscription", () => {
    expect(reconcileSubscription(undefined, url, NOW)).toEqual({ action: "create" });
  });

  it("create when URL doesn't match", () => {
    expect(
      reconcileSubscription(
        { notificationUrl: "https://smee.io/old", expirationDateTime: futureExp },
        url,
        NOW,
      ),
    ).toEqual({ action: "create" });
  });

  it("create when expiration is in the past", () => {
    expect(
      reconcileSubscription({ notificationUrl: url, expirationDateTime: past }, url, NOW),
    ).toEqual({ action: "create" });
  });

  it("renew when in renew slack window but still valid", () => {
    expect(
      reconcileSubscription(
        { notificationUrl: url, expirationDateTime: inRenewWindow },
        url,
        NOW,
      ),
    ).toEqual({ action: "renew" });
  });

  it("none when subscription is fresh", () => {
    expect(
      reconcileSubscription({ notificationUrl: url, expirationDateTime: futureExp }, url, NOW),
    ).toEqual({ action: "none" });
  });

  it("create when expirationDateTime is missing entirely (fail-closed)", () => {
    expect(
      reconcileSubscription(
        { notificationUrl: url, expirationDateTime: undefined },
        url,
        NOW,
      ),
    ).toEqual({ action: "create" });
  });
});
