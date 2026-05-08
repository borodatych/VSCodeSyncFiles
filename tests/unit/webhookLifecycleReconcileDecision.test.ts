import { describe, expect, it } from "vitest";
import {
  planWebhookLifecycleReconcile,
  type PersistedSubscriptionState,
  type ReconcilePlanInput,
} from "../../src/core/webhookLifecycleReconcileDecision.js";

const STATE: PersistedSubscriptionState = {
  subscriptionId: "sub-1",
  expirationDateTime: "2026-05-08T12:00:00Z",
  notificationUrl: "https://smee.io/abc",
  clientState: "cs-hex-deadbeef",
};

function input(overrides: Partial<ReconcilePlanInput> = {}): ReconcilePlanInput {
  return {
    webhooksEnabled: true,
    resolvedNotificationUrl: "https://smee.io/abc",
    localPort: 0,
    activeProviderMatches: true,
    hasToken: true,
    persistedState: null,
    ...overrides,
  };
}

describe("planWebhookLifecycleReconcile — provider mismatch", () => {
  it("tears down existing state when active provider switched away", () => {
    const r = planWebhookLifecycleReconcile(
      input({ activeProviderMatches: false, persistedState: STATE }),
    );
    expect(r.lifecycleActive).toBe(false);
    expect(r.inactiveReason).toBe("provider_mismatch");
    expect(r.actions.map((a) => a.kind)).toEqual([
      "delete_stale_subscription",
      "clear_local_state",
    ]);
  });

  it("emits no actions when provider mismatch + no persisted state", () => {
    const r = planWebhookLifecycleReconcile(
      input({ activeProviderMatches: false, persistedState: null }),
    );
    expect(r.lifecycleActive).toBe(false);
    expect(r.actions).toEqual([]);
  });
});

describe("planWebhookLifecycleReconcile — disabled / no URL", () => {
  it("tears down when webhooks toggle is off", () => {
    const r = planWebhookLifecycleReconcile(
      input({ webhooksEnabled: false, persistedState: STATE }),
    );
    expect(r.lifecycleActive).toBe(false);
    expect(r.inactiveReason).toBe("webhooks_disabled");
    expect(r.actions.map((a) => a.kind)).toEqual([
      "delete_stale_subscription",
      "clear_local_state",
    ]);
  });

  it("tears down when no resolved notification URL", () => {
    const r = planWebhookLifecycleReconcile(
      input({ resolvedNotificationUrl: "", persistedState: STATE }),
    );
    expect(r.lifecycleActive).toBe(false);
    expect(r.inactiveReason).toBe("no_notification_url");
  });

  it("emits no actions on disabled+no-state (idempotent)", () => {
    const r = planWebhookLifecycleReconcile(
      input({ webhooksEnabled: false, persistedState: null }),
    );
    expect(r.lifecycleActive).toBe(false);
    expect(r.actions).toEqual([]);
  });
});

describe("planWebhookLifecycleReconcile — no token", () => {
  it("returns no_token without any side-effects", () => {
    const r = planWebhookLifecycleReconcile(input({ hasToken: false, persistedState: STATE }));
    expect(r.lifecycleActive).toBe(false);
    expect(r.inactiveReason).toBe("no_token");
    expect(r.actions).toEqual([]);
  });
});

describe("planWebhookLifecycleReconcile — fresh start", () => {
  it("creates subscription when no persisted state", () => {
    const r = planWebhookLifecycleReconcile(input({ persistedState: null }));
    expect(r.lifecycleActive).toBe(true);
    const kinds = r.actions.map((a) => a.kind);
    expect(kinds).toEqual([
      "create_subscription",
      "register_webhook_push",
      "start_renew_loop",
    ]);
    const create = r.actions.find((a) => a.kind === "create_subscription");
    if (create?.kind !== "create_subscription") throw new Error();
    expect(create.reuseClientState).toBeNull();
  });

  it("starts local server before creating subscription when localPort > 0", () => {
    const r = planWebhookLifecycleReconcile(input({ localPort: 7777 }));
    expect(r.actions.map((a) => a.kind)).toEqual([
      "start_local_server",
      "create_subscription",
      "register_webhook_push",
      "start_renew_loop",
    ]);
    const local = r.actions.find((a) => a.kind === "start_local_server");
    if (local?.kind !== "start_local_server") throw new Error();
    expect(local.port).toBe(7777);
  });

  it("uses default 4-minute renew interval", () => {
    const r = planWebhookLifecycleReconcile(input());
    const renew = r.actions.find((a) => a.kind === "start_renew_loop");
    if (renew?.kind !== "start_renew_loop") throw new Error();
    expect(renew.intervalMs).toBe(4 * 60_000);
  });

  it("respects an override renew interval", () => {
    const r = planWebhookLifecycleReconcile(input({ renewIntervalMs: 30_000 }));
    const renew = r.actions.find((a) => a.kind === "start_renew_loop");
    if (renew?.kind !== "start_renew_loop") throw new Error();
    expect(renew.intervalMs).toBe(30_000);
  });
});

describe("planWebhookLifecycleReconcile — URL drift", () => {
  it("recreates when persisted URL no longer matches current resolved URL", () => {
    const r = planWebhookLifecycleReconcile(
      input({
        persistedState: { ...STATE, notificationUrl: "https://smee.io/old" },
        resolvedNotificationUrl: "https://smee.io/new",
      }),
    );
    expect(r.lifecycleActive).toBe(true);
    expect(r.actions.map((a) => a.kind)).toEqual([
      "delete_stale_subscription",
      "clear_local_state",
      "create_subscription",
      "register_webhook_push",
      "start_renew_loop",
    ]);
    const del = r.actions.find((a) => a.kind === "delete_stale_subscription");
    if (del?.kind !== "delete_stale_subscription") throw new Error();
    expect(del.reason).toBe("url_changed");
  });

  it("after URL-drift recreate, reuses old clientState (cuts churn)", () => {
    const r = planWebhookLifecycleReconcile(
      input({
        persistedState: { ...STATE, notificationUrl: "https://smee.io/old" },
        resolvedNotificationUrl: "https://smee.io/new",
      }),
    );
    const create = r.actions.find((a) => a.kind === "create_subscription");
    if (create?.kind !== "create_subscription") throw new Error();
    expect(create.reuseClientState).toBe(STATE.clientState);
  });
});

describe("planWebhookLifecycleReconcile — keep existing", () => {
  it("keeps subscription when persisted URL matches resolved URL", () => {
    const r = planWebhookLifecycleReconcile(
      input({ persistedState: STATE, resolvedNotificationUrl: STATE.notificationUrl }),
    );
    expect(r.lifecycleActive).toBe(true);
    const kinds = r.actions.map((a) => a.kind);
    expect(kinds).toEqual([
      "keep_subscription",
      "register_webhook_push",
      "start_renew_loop",
    ]);
    const keep = r.actions.find((a) => a.kind === "keep_subscription");
    if (keep?.kind !== "keep_subscription") throw new Error();
    expect(keep.subscriptionId).toBe("sub-1");
  });

  it("keep + local-server appear in correct order", () => {
    const r = planWebhookLifecycleReconcile(
      input({ persistedState: STATE, localPort: 8888 }),
    );
    expect(r.actions.map((a) => a.kind)).toEqual([
      "start_local_server",
      "keep_subscription",
      "register_webhook_push",
      "start_renew_loop",
    ]);
  });
});
