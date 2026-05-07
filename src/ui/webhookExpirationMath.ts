/**
 * Pure expiration helpers shared by Microsoft Graph and Google Drive
 * webhook lifecycles. Both providers issue subscriptions with an
 * `expirationDateTime` and require the caller to renew before the deadline.
 *
 * vscode-free: covered by unit tests. Default slack values match the live
 * lifecycle constants:
 *   - 120_000 ms (2 min) — "still valid?" when reusing an existing subscription
 *   - 20 * 60_000 ms (20 min) — "renew now?" before the deadline
 *
 * `now` and `slackMs` are explicit so tests are deterministic.
 */

export const SUBSCRIPTION_VALID_SLACK_MS = 120_000;
export const SUBSCRIPTION_RENEW_SLACK_MS = 20 * 60_000;

/**
 * `true` if the subscription is within `slackMs` of expiry, or already past.
 * `true` is also returned when the timestamp can't be parsed — fail-closed:
 * unknown state should trigger a re-subscribe, not silently expire.
 */
export function isNearOrPastExpiration(
  expirationIso: string | undefined,
  slackMs: number,
  now: number = Date.now(),
): boolean {
  if (expirationIso === undefined || expirationIso.length === 0) return true;
  const t = Date.parse(expirationIso);
  if (Number.isNaN(t)) return true;
  return t - slackMs <= now;
}

export type ReconcileDecision =
  | { action: "create" }
  | { action: "renew" }
  | { action: "none" };

export interface ExistingSubscription {
  /** Microsoft Graph / Google Drive expiration as an ISO-8601 string. */
  expirationDateTime: string | undefined;
  /** Subscription's notification URL (we re-create when the URL doesn't match). */
  notificationUrl: string | undefined;
}

/**
 * Returns the next action for the lifecycle reconciler.
 *
 *   - `create` — no existing subscription, or its URL no longer matches what
 *      we want to expose, or it's expired.
 *   - `renew` — subscription still valid but inside the renewal window.
 *   - `none` — leave it alone.
 */
export function reconcileSubscription(
  existing: ExistingSubscription | undefined,
  desiredNotificationUrl: string,
  now: number = Date.now(),
): ReconcileDecision {
  if (!existing) return { action: "create" };
  if (existing.notificationUrl !== desiredNotificationUrl) return { action: "create" };
  if (isNearOrPastExpiration(existing.expirationDateTime, SUBSCRIPTION_VALID_SLACK_MS, now)) {
    return { action: "create" };
  }
  if (isNearOrPastExpiration(existing.expirationDateTime, SUBSCRIPTION_RENEW_SLACK_MS, now)) {
    return { action: "renew" };
  }
  return { action: "none" };
}

/**
 * Provider-format-agnostic variant: caller supplies pre-computed flags. Used
 * by Google Drive, whose `expiration` is an epoch-ms string rather than
 * ISO-8601, so the parser is provider-specific but the decision tree is
 * the same.
 */
export function reconcileFromFlags(opts: {
  hasExisting: boolean;
  urlOk: boolean;
  withinValidSlack: boolean;
  withinRenewSlack: boolean;
}): ReconcileDecision {
  if (!opts.hasExisting) return { action: "create" };
  if (!opts.urlOk) return { action: "create" };
  if (opts.withinValidSlack) return { action: "create" };
  if (opts.withinRenewSlack) return { action: "renew" };
  return { action: "none" };
}
