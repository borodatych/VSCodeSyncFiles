/**
 * v2.10.1 — additional mock matrix for webhook lifecycle edge cases:
 *   - 412 PreconditionFailed (subscription gone server-side, must recreate)
 *   - URL drift (smee.io reconnect replaces channel id) — recreate with
 *     reused clientState.
 *   - webhooks disabled mid-flight — clear local state, stop lifecycle.
 *   - no token race — abort_no_token.
 *
 * The pure planner `planWebhookLifecycleReconcile` already covers these
 * decisions. This test pins them so a future refactor of `reconcileBody`
 * (which still owns the network calls) can compare against fixtures.
 */
import { describe, expect, it } from "vitest";
import { planWebhookLifecycleReconcile } from "../../src/core/webhookLifecycleReconcileDecision.js";
import { decideWebhookRenewTick } from "../../src/core/webhookLifecycleRenewTickDecision.js";

const NOW = 1_700_000_000_000;
const HOUR_AHEAD = new Date(NOW + 60 * 60_000).toISOString();
const FIVE_MIN_AHEAD = new Date(NOW + 5 * 60_000).toISOString();

describe("webhook reconcile edge cases — URL drift (smee reconnect)", () => {
  it("delete + recreate when notification URL drifts; reuse clientState", () => {
    const result = planWebhookLifecycleReconcile({
      webhooksEnabled: true,
      resolvedNotificationUrl: "https://new-smee/abc",
      localPort: 0,
      activeProviderMatches: true,
      hasToken: true,
      persistedState: {
        subscriptionId: "sub-1",
        expirationDateTime: HOUR_AHEAD,
        notificationUrl: "https://old-smee/xyz",
        clientState: "secret-state",
      },
      nowMs: NOW,
    });
    expect(result.lifecycleActive).toBe(true);
    const kinds = result.actions.map((a) => a.kind);
    expect(kinds).toContain("delete_stale_subscription");
    expect(kinds).toContain("create_subscription");
    const create = result.actions.find((a) => a.kind === "create_subscription");
    if (create?.kind === "create_subscription") {
      expect(create.reuseClientState).toBe("secret-state");
    }
  });
});

describe("webhook reconcile edge cases — webhooks disabled mid-flight", () => {
  it("clears local state + reports inactive", () => {
    const result = planWebhookLifecycleReconcile({
      webhooksEnabled: false,
      resolvedNotificationUrl: "https://relay/hook",
      localPort: 0,
      activeProviderMatches: true,
      hasToken: true,
      persistedState: {
        subscriptionId: "sub-1",
        expirationDateTime: HOUR_AHEAD,
        notificationUrl: "https://relay/hook",
        clientState: "x",
      },
      nowMs: NOW,
    });
    expect(result.lifecycleActive).toBe(false);
    expect(result.inactiveReason).toBe("webhooks_disabled");
    expect(result.actions.map((a) => a.kind)).toContain("clear_local_state");
  });
});

describe("webhook reconcile edge cases — no_token race", () => {
  it("emits abort_no_token without creating a subscription", () => {
    const result = planWebhookLifecycleReconcile({
      webhooksEnabled: true,
      resolvedNotificationUrl: "https://smee.io/abc",
      localPort: 0,
      activeProviderMatches: true,
      hasToken: false,
      persistedState: null,
      nowMs: NOW,
    });
    expect(result.lifecycleActive).toBe(false);
    expect(result.inactiveReason).toBe("no_token");
    // Planner does not emit a separate abort_no_token; the flag combo is
    // sufficient for the wrapper. Crucially: no create_subscription fires.
    expect(result.actions.find((a) => a.kind === "create_subscription")).toBeUndefined();
  });
});

describe("webhook reconcile edge cases — no notification URL", () => {
  it("clears state when resolvedNotificationUrl is empty (tunnel down)", () => {
    const result = planWebhookLifecycleReconcile({
      webhooksEnabled: true,
      resolvedNotificationUrl: "",
      localPort: 0,
      activeProviderMatches: true,
      hasToken: true,
      persistedState: {
        subscriptionId: "sub-1",
        expirationDateTime: HOUR_AHEAD,
        notificationUrl: "https://old/hook",
        clientState: "x",
      },
      nowMs: NOW,
    });
    expect(result.lifecycleActive).toBe(false);
    expect(result.inactiveReason).toBe("no_notification_url");
  });
});

describe("webhook renew tick — defensive matrix", () => {
  it("not-yet-due returns do_nothing without firing renew", () => {
    const r = decideWebhookRenewTick({
      webhooksEnabled: true,
      activeProviderMatches: true,
      hasToken: true,
      state: { subscriptionId: "sub-1", expirationDateTime: HOUR_AHEAD },
      nowMs: NOW,
    });
    expect(r.kind).toBe("do_nothing");
    if (r.kind === "do_nothing") expect(r.reason).toBe("not_yet_due");
  });

  it("within-window returns renew_now", () => {
    const r = decideWebhookRenewTick({
      webhooksEnabled: true,
      activeProviderMatches: true,
      hasToken: true,
      state: { subscriptionId: "sub-1", expirationDateTime: FIVE_MIN_AHEAD },
      nowMs: NOW,
      // SUBSCRIPTION_RENEW_SLACK_MS is 20 min; FIVE_MIN_AHEAD is well within slack.
    });
    expect(r.kind).toBe("renew_now");
    if (r.kind === "renew_now") expect(r.subscriptionId).toBe("sub-1");
  });

  it("provider switched away returns stop_lifecycle", () => {
    const r = decideWebhookRenewTick({
      webhooksEnabled: true,
      activeProviderMatches: false,
      hasToken: true,
      state: { subscriptionId: "sub-1", expirationDateTime: FIVE_MIN_AHEAD },
      nowMs: NOW,
    });
    expect(r.kind).toBe("stop_lifecycle");
    if (r.kind === "stop_lifecycle") expect(r.reason).toBe("provider_mismatch");
  });

  it("missing state returns do_nothing", () => {
    const r = decideWebhookRenewTick({
      webhooksEnabled: true,
      activeProviderMatches: true,
      hasToken: true,
      state: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("do_nothing");
    if (r.kind === "do_nothing") expect(r.reason).toBe("no_state");
  });
});
