/**
 * v2.10.1 — pure decision for the `renewTick` callback inside the
 * OneDrive / Google Drive webhook lifecycle.
 *
 * Today the inline tick body in each lifecycle module reads vscode config,
 * the persisted state file, the secret bundle, and the active provider.
 * Most of those reads are side-effects, but the *decision* — given those
 * already-resolved values, what should happen next? — is a pure function:
 *
 *   - state missing? → `{ kind: "do_nothing" }`
 *   - webhooks toggled off? → `{ kind: "stop_lifecycle" }`
 *   - provider switched away? → `{ kind: "stop_lifecycle" }`
 *   - token absent? → `{ kind: "do_nothing" }` (caller logs)
 *   - within renew window? → `{ kind: "renew_now" }`
 *   - otherwise → `{ kind: "do_nothing" }`
 *
 * The wrapper iterates these decisions on a `setInterval`; the pure planner
 * makes the lifecycle mock-testable for the first time.
 */

import { isNearOrPastExpiration, SUBSCRIPTION_RENEW_SLACK_MS } from "../ui/webhookExpirationMath.js";

export type RenewTickDecision =
  | { kind: "do_nothing"; reason: RenewSkipReason }
  | { kind: "renew_now"; subscriptionId: string }
  | { kind: "stop_lifecycle"; reason: StopReason };

export type RenewSkipReason =
  | "no_state"
  | "no_token"
  | "not_yet_due";

export type StopReason =
  | "webhooks_disabled"
  | "provider_mismatch";

export interface RenewTickInput {
  /** Persisted lifecycle state read from disk inside the wrapper. */
  state: { subscriptionId: string; expirationDateTime: string } | null;
  /** Current `vscodesync.webhooks.enabled` value. */
  webhooksEnabled: boolean;
  /** Whether the active provider in `globalConfig` still matches this lifecycle. */
  activeProviderMatches: boolean;
  /** Whether the secret bundle yielded a usable access token. */
  hasToken: boolean;
  /** ms before expiry at which a renewal is overdue. Defaults to the
   *  shared `SUBSCRIPTION_RENEW_SLACK_MS`. */
  renewSlackMs?: number;
  /** Wall-clock for the comparison. Pass an explicit value in tests. */
  nowMs?: number;
}

export function decideWebhookRenewTick(input: RenewTickInput): RenewTickDecision {
  const renewSlackMs = input.renewSlackMs ?? SUBSCRIPTION_RENEW_SLACK_MS;
  if (input.state === null) {
    return { kind: "do_nothing", reason: "no_state" };
  }
  if (!input.webhooksEnabled) {
    return { kind: "stop_lifecycle", reason: "webhooks_disabled" };
  }
  if (!input.activeProviderMatches) {
    return { kind: "stop_lifecycle", reason: "provider_mismatch" };
  }
  if (!input.hasToken) {
    return { kind: "do_nothing", reason: "no_token" };
  }
  if (!isNearOrPastExpiration(input.state.expirationDateTime, renewSlackMs, input.nowMs)) {
    return { kind: "do_nothing", reason: "not_yet_due" };
  }
  return { kind: "renew_now", subscriptionId: input.state.subscriptionId };
}
