import { describe, expect, it } from "vitest";
import { decideWebhookRenewTick } from "../../src/core/webhookLifecycleRenewTickDecision.js";
import { SUBSCRIPTION_RENEW_SLACK_MS } from "../../src/ui/webhookExpirationMath.js";

const NOW = 1_700_000_000_000;

function isoIn(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

describe("decideWebhookRenewTick — early exits", () => {
  it("do_nothing/no_state when state is null", () => {
    const r = decideWebhookRenewTick({
      state: null,
      webhooksEnabled: true,
      activeProviderMatches: true,
      hasToken: true,
      nowMs: NOW,
    });
    expect(r.kind).toBe("do_nothing");
    if (r.kind !== "do_nothing") throw new Error();
    expect(r.reason).toBe("no_state");
  });

  it("stop_lifecycle/webhooks_disabled wins over expiration check", () => {
    const r = decideWebhookRenewTick({
      state: { subscriptionId: "s1", expirationDateTime: isoIn(60_000) },
      webhooksEnabled: false,
      activeProviderMatches: true,
      hasToken: true,
      nowMs: NOW,
    });
    expect(r.kind).toBe("stop_lifecycle");
    if (r.kind !== "stop_lifecycle") throw new Error();
    expect(r.reason).toBe("webhooks_disabled");
  });

  it("stop_lifecycle/provider_mismatch when active provider no longer matches", () => {
    const r = decideWebhookRenewTick({
      state: { subscriptionId: "s1", expirationDateTime: isoIn(60_000) },
      webhooksEnabled: true,
      activeProviderMatches: false,
      hasToken: true,
      nowMs: NOW,
    });
    expect(r.kind).toBe("stop_lifecycle");
    if (r.kind !== "stop_lifecycle") throw new Error();
    expect(r.reason).toBe("provider_mismatch");
  });

  it("do_nothing/no_token when bundle missing", () => {
    const r = decideWebhookRenewTick({
      state: { subscriptionId: "s1", expirationDateTime: isoIn(60_000) },
      webhooksEnabled: true,
      activeProviderMatches: true,
      hasToken: false,
      nowMs: NOW,
    });
    expect(r.kind).toBe("do_nothing");
    if (r.kind !== "do_nothing") throw new Error();
    expect(r.reason).toBe("no_token");
  });
});

describe("decideWebhookRenewTick — renewal window", () => {
  it("do_nothing/not_yet_due when expiration > slack from now", () => {
    const r = decideWebhookRenewTick({
      state: {
        subscriptionId: "s1",
        expirationDateTime: isoIn(SUBSCRIPTION_RENEW_SLACK_MS + 60_000),
      },
      webhooksEnabled: true,
      activeProviderMatches: true,
      hasToken: true,
      nowMs: NOW,
    });
    expect(r.kind).toBe("do_nothing");
    if (r.kind !== "do_nothing") throw new Error();
    expect(r.reason).toBe("not_yet_due");
  });

  it("renew_now when expiration is within renew slack", () => {
    const r = decideWebhookRenewTick({
      state: {
        subscriptionId: "s-renew",
        expirationDateTime: isoIn(SUBSCRIPTION_RENEW_SLACK_MS - 30_000),
      },
      webhooksEnabled: true,
      activeProviderMatches: true,
      hasToken: true,
      nowMs: NOW,
    });
    expect(r.kind).toBe("renew_now");
    if (r.kind !== "renew_now") throw new Error();
    expect(r.subscriptionId).toBe("s-renew");
  });

  it("renew_now when expiration is already in the past (fail-closed)", () => {
    const r = decideWebhookRenewTick({
      state: { subscriptionId: "s-old", expirationDateTime: isoIn(-3_600_000) },
      webhooksEnabled: true,
      activeProviderMatches: true,
      hasToken: true,
      nowMs: NOW,
    });
    expect(r.kind).toBe("renew_now");
  });

  it("renew_now when expirationDateTime is unparseable (fail-closed)", () => {
    const r = decideWebhookRenewTick({
      state: { subscriptionId: "s-bad", expirationDateTime: "not-a-date" },
      webhooksEnabled: true,
      activeProviderMatches: true,
      hasToken: true,
      nowMs: NOW,
    });
    expect(r.kind).toBe("renew_now");
  });
});

describe("decideWebhookRenewTick — slack override", () => {
  it("respects a custom renewSlackMs", () => {
    const customSlack = 60_000;
    const r = decideWebhookRenewTick({
      state: { subscriptionId: "s1", expirationDateTime: isoIn(120_000) },
      webhooksEnabled: true,
      activeProviderMatches: true,
      hasToken: true,
      renewSlackMs: customSlack,
      nowMs: NOW,
    });
    // 120s > 60s slack → not yet due
    expect(r.kind).toBe("do_nothing");
    if (r.kind !== "do_nothing") throw new Error();
    expect(r.reason).toBe("not_yet_due");
  });

  it("triggers renew_now when within the custom slack", () => {
    const r = decideWebhookRenewTick({
      state: { subscriptionId: "s1", expirationDateTime: isoIn(30_000) },
      webhooksEnabled: true,
      activeProviderMatches: true,
      hasToken: true,
      renewSlackMs: 60_000,
      nowMs: NOW,
    });
    expect(r.kind).toBe("renew_now");
  });
});

describe("decideWebhookRenewTick — early exits priority", () => {
  it("no_state takes priority over disabled flag", () => {
    const r = decideWebhookRenewTick({
      state: null,
      webhooksEnabled: false,
      activeProviderMatches: true,
      hasToken: true,
      nowMs: NOW,
    });
    expect(r.kind).toBe("do_nothing");
    if (r.kind !== "do_nothing") throw new Error();
    expect(r.reason).toBe("no_state");
  });
});
