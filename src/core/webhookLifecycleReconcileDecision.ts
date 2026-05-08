/**
 * v2.10.1 — pure planner for the OneDrive / Google Drive webhook
 * lifecycle's `reconcile` step.
 *
 * Both `oneDriveWebhookLifecycle.ts` and `googleDriveWebhookLifecycle.ts`
 * drive the same decision tree: "given current persisted state + current
 * config, what side-effects should run?". Today the logic is inlined,
 * making it impossible to mock-test without standing up vscode + the
 * remote provider. This planner extracts the decision so the wrapper is
 * a thin imperative shell over a pure ordered action list.
 *
 * Caller binds each action to a side-effect:
 *
 *   - `delete_stale_subscription` → `graphDeleteSubscription(...)` (or GD equivalent).
 *   - `clear_local_state`         → `fs.unlink(state.json)`.
 *   - `start_local_server`        → `startGraphWebhookLocalServer(...)`.
 *   - `create_subscription`       → `graph*CreateSubscription(...)` then `writeState(...)`.
 *   - `keep_subscription`         → no-op (state already correct).
 *   - `register_webhook_push`     → `activateWebhookPushFor(...)`.
 *   - `start_renew_loop`          → `setInterval(...)`.
 *
 * No `vscode`, no IO. The caller resolves the notification URL (incl.
 * smee.io / cloudflared tunnel) BEFORE calling the planner — the planner
 * works on a fully-resolved URL or empty string.
 */

export interface PersistedSubscriptionState {
  subscriptionId: string;
  expirationDateTime: string;
  notificationUrl: string;
  clientState: string;
}

export interface ReconcilePlanInput {
  /** `vscodesync.webhooks.enabled` (top-level toggle). */
  webhooksEnabled: boolean;
  /** Final notification URL after tunnel resolution; "" / undefined means
   *  the lifecycle has no public ingress. */
  resolvedNotificationUrl: string;
  /** `vscodesync.webhooks.localPort` (0 = no local server). */
  localPort: number;
  /** Whether `globalConfig.activeProvider` matches this lifecycle's provider. */
  activeProviderMatches: boolean;
  /** Whether the provider's secret bundle yielded a usable access token. */
  hasToken: boolean;
  /** Last persisted subscription record from disk. */
  persistedState: PersistedSubscriptionState | null;
  /** Renew-loop interval (4 minutes by default). */
  renewIntervalMs?: number;
  /** Current wall-clock for deciding URL drift / expiration boundaries. */
  nowMs?: number;
}

export type TearDownReason =
  | "provider_mismatch"
  | "webhooks_disabled"
  | "no_notification_url"
  | "url_changed";

export type ReconcileAction =
  | { kind: "delete_stale_subscription"; subscriptionId: string; reason: TearDownReason }
  | { kind: "clear_local_state" }
  | { kind: "abort_no_token" }
  | { kind: "start_local_server"; port: number }
  | { kind: "create_subscription"; reuseClientState: string | null }
  | { kind: "keep_subscription"; subscriptionId: string }
  | { kind: "register_webhook_push" }
  | { kind: "start_renew_loop"; intervalMs: number };

export interface ReconcilePlanOutput {
  /** Ordered side-effect plan. */
  actions: ReconcileAction[];
  /** `true` when the lifecycle should remain active after these actions
   *  run. `false` means the wrapper should stop and not start the renew
   *  loop. */
  lifecycleActive: boolean;
  /** Surfaced reason when `lifecycleActive` is false (for log lines). */
  inactiveReason?: TearDownReason | "no_token";
}

const DEFAULT_RENEW_INTERVAL_MS = 4 * 60_000;

export function planWebhookLifecycleReconcile(input: ReconcilePlanInput): ReconcilePlanOutput {
  const renewIntervalMs = input.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
  const actions: ReconcileAction[] = [];

  // Branch A — provider switched away from us. Delete remote subscription
  // (if any), clear state, and return inactive.
  if (!input.activeProviderMatches) {
    if (input.persistedState !== null) {
      actions.push({
        kind: "delete_stale_subscription",
        subscriptionId: input.persistedState.subscriptionId,
        reason: "provider_mismatch",
      });
      actions.push({ kind: "clear_local_state" });
    }
    return { actions, lifecycleActive: false, inactiveReason: "provider_mismatch" };
  }

  // Branch B — webhooks toggled off OR no notification URL resolved.
  // Tear down whatever subscription we have, return inactive.
  if (!input.webhooksEnabled || input.resolvedNotificationUrl.length === 0) {
    const reason: TearDownReason = !input.webhooksEnabled
      ? "webhooks_disabled"
      : "no_notification_url";
    if (input.persistedState !== null) {
      actions.push({
        kind: "delete_stale_subscription",
        subscriptionId: input.persistedState.subscriptionId,
        reason,
      });
      actions.push({ kind: "clear_local_state" });
    }
    return { actions, lifecycleActive: false, inactiveReason: reason };
  }

  // Branch C — we are active but the secret bundle is missing.
  if (!input.hasToken) {
    return { actions, lifecycleActive: false, inactiveReason: "no_token" };
  }

  // Branch D — URL drift: existing persisted state points to a different
  // tunnel URL. Drop it and recreate from scratch.
  let stateToReuse: PersistedSubscriptionState | null = input.persistedState;
  if (
    stateToReuse !== null &&
    stateToReuse.notificationUrl !== input.resolvedNotificationUrl
  ) {
    actions.push({
      kind: "delete_stale_subscription",
      subscriptionId: stateToReuse.subscriptionId,
      reason: "url_changed",
    });
    actions.push({ kind: "clear_local_state" });
    stateToReuse = null;
  }

  // Local server (if configured) starts before subscription create — it
  // must be listening before the provider's first push lands.
  if (input.localPort > 0) {
    actions.push({ kind: "start_local_server", port: input.localPort });
  }

  // Subscription action: keep when state survived branch D, else create.
  if (stateToReuse !== null) {
    actions.push({ kind: "keep_subscription", subscriptionId: stateToReuse.subscriptionId });
  } else {
    actions.push({
      kind: "create_subscription",
      reuseClientState: input.persistedState?.clientState ?? null,
    });
  }

  actions.push({ kind: "register_webhook_push" });
  actions.push({ kind: "start_renew_loop", intervalMs: renewIntervalMs });

  return { actions, lifecycleActive: true };
}
