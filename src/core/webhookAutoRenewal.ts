/**
 * v2.10.2 — pure helpers for the webhook auto-renewal background timer.
 *
 * Caller (extension activate) constructs a renewal scheduler from a list of
 * subscriptions; the scheduler reports `pendingActions` (renew now / wait
 * until / expired-must-recreate). Caller drives a real `setInterval`; this
 * module just answers "what should I do for this set of subscriptions at
 * this `now`?".
 */
import { isNearOrPastExpiration, SUBSCRIPTION_RENEW_SLACK_MS } from "./webhookExpirationMath.js";

export interface WebhookSubscription {
  /** Provider-specific id; surfaced back so caller knows which to renew. */
  id: string;
  /** ISO timestamp when the provider will stop sending notifications. */
  expiresAtIso: string;
}

export type WebhookRenewalAction =
  | { kind: "renew_now"; subscription: WebhookSubscription }
  | { kind: "expired_recreate"; subscription: WebhookSubscription }
  | { kind: "wait_until"; subscription: WebhookSubscription; nextDueMs: number };

export interface WebhookRenewalReport {
  actions: WebhookRenewalAction[];
  /** Earliest `nextDueMs` across all subscriptions (for setTimeout sizing).
   * Undefined if no subscriptions need waiting (all renew_now or
   * expired_recreate). */
  nextWakeMs?: number;
}

/** Build a per-subscription action list. Decisions:
 *   - already past expiry → `expired_recreate`
 *   - within renew slack window (≤ 20 min before expiry) → `renew_now`
 *   - else `wait_until` with the timestamp that crosses into the slack
 */
export function planWebhookRenewal(
  subscriptions: WebhookSubscription[],
  now: number = Date.now(),
  slackMs: number = SUBSCRIPTION_RENEW_SLACK_MS,
): WebhookRenewalReport {
  const actions: WebhookRenewalAction[] = [];
  let nextWakeMs: number | undefined = undefined;

  for (const s of subscriptions) {
    const exp = Date.parse(s.expiresAtIso);
    if (Number.isNaN(exp)) {
      // Unparseable expiry → treat as expired so the caller recreates.
      actions.push({ kind: "expired_recreate", subscription: s });
      continue;
    }
    if (exp <= now) {
      actions.push({ kind: "expired_recreate", subscription: s });
      continue;
    }
    if (isNearOrPastExpiration(s.expiresAtIso, slackMs, now)) {
      actions.push({ kind: "renew_now", subscription: s });
      continue;
    }
    const nextDue = exp - slackMs;
    actions.push({ kind: "wait_until", subscription: s, nextDueMs: nextDue });
    if (nextWakeMs === undefined || nextDue < nextWakeMs) nextWakeMs = nextDue;
  }

  return nextWakeMs !== undefined ? { actions, nextWakeMs } : { actions };
}
