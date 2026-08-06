import { describe, expect, it } from "vitest";
import { planWebhookRenewal } from "../../src/core/webhookAutoRenewal.js";
import { SUBSCRIPTION_RENEW_SLACK_MS } from "../../src/core/webhookExpirationMath.js";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

describe("planWebhookRenewal", () => {
  it("schedules wait_until when expiry is far in the future", () => {
    const r = planWebhookRenewal(
      [{ id: "a", expiresAtIso: iso(2 * 60 * 60 * 1000) }],
      NOW,
    );
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]?.kind).toBe("wait_until");
    if (r.actions[0]?.kind === "wait_until") {
      expect(r.actions[0].nextDueMs).toBe(NOW + 2 * 60 * 60 * 1000 - SUBSCRIPTION_RENEW_SLACK_MS);
    }
    expect(r.nextWakeMs).toBeDefined();
  });

  it("flags renew_now when within slack window", () => {
    // 5 min before expiry — well within 20 min slack.
    const r = planWebhookRenewal(
      [{ id: "a", expiresAtIso: iso(5 * 60_000) }],
      NOW,
    );
    expect(r.actions[0]?.kind).toBe("renew_now");
  });

  it("flags expired_recreate when past expiry", () => {
    const r = planWebhookRenewal(
      [{ id: "a", expiresAtIso: iso(-1) }],
      NOW,
    );
    expect(r.actions[0]?.kind).toBe("expired_recreate");
  });

  it("flags expired_recreate when iso is unparseable", () => {
    const r = planWebhookRenewal(
      [{ id: "a", expiresAtIso: "not-an-iso" }],
      NOW,
    );
    expect(r.actions[0]?.kind).toBe("expired_recreate");
  });

  it("nextWakeMs picks the earliest wait_until across subscriptions", () => {
    const r = planWebhookRenewal(
      [
        { id: "a", expiresAtIso: iso(60 * 60_000) }, // 1h → wait
        { id: "b", expiresAtIso: iso(40 * 60_000) }, // 40m → wait
      ],
      NOW,
    );
    expect(r.nextWakeMs).toBe(NOW + 40 * 60_000 - SUBSCRIPTION_RENEW_SLACK_MS);
  });

  it("nextWakeMs is undefined when no subscription needs waiting", () => {
    const r = planWebhookRenewal(
      [
        { id: "a", expiresAtIso: iso(5 * 60_000) }, // renew_now
        { id: "b", expiresAtIso: iso(-1) }, // expired_recreate
      ],
      NOW,
    );
    expect(r.nextWakeMs).toBeUndefined();
  });
});
