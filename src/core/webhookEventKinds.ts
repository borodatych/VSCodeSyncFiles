/**
 * Cross-cutting — pure catalog of webhook event kinds per provider, plus a
 * helper that classifies an inbound event-kind string against the catalog.
 *
 * Used by `oneDriveWebhookLifecycle.ts` / `googleDriveWebhookLifecycle.ts`
 * to validate inbound payloads and reject unknown kinds before mutating
 * any state.
 *
 * No `vscode` import. Provider lifecycle modules supply the wire-format
 * adapter; this module supplies the truth table.
 */

import type { ProviderType } from "./types.js";

export type WebhookEventKindClassification =
  | "supported"
  | "undocumented"
  | "unsupported_provider";

/** Catalog of event kinds we know how to consume per provider. The keys
 * here come straight from the provider's documented payload shapes — keep
 * in sync with the lifecycle module for that provider. */
export const WEBHOOK_EVENT_KINDS: Partial<Record<ProviderType, ReadonlySet<string>>> = {
  onedrive: new Set([
    "updated",
    "deleted",
    "created",
  ]),
  gdrive: new Set([
    "add",
    "change",
    "remove",
    "update",
    "trash",
    "untrash",
    "sync",
  ]),
  // Yandex / Dropbox webhook surfaces are out of scope until webhook
  // lifecycle support lands for those providers.
};

/** Classify an inbound `eventKind` string. */
export function classifyWebhookEvent(
  provider: ProviderType,
  eventKind: string,
): WebhookEventKindClassification {
  const known = WEBHOOK_EVENT_KINDS[provider];
  if (known === undefined) return "unsupported_provider";
  if (known.has(eventKind)) return "supported";
  return "undocumented";
}

/** Produce a sorted snapshot of supported event kinds for diagnostics. */
export function listSupportedEventKinds(provider: ProviderType): string[] {
  const set = WEBHOOK_EVENT_KINDS[provider];
  if (!set) return [];
  return [...set].sort();
}

/** True if any event in the list maps to a documented webhook kind for the
 * provider. Useful as a quick "should we forward to engine" gate. */
export function hasSupportedEventKind(
  provider: ProviderType,
  eventKinds: readonly string[],
): boolean {
  return eventKinds.some((k) => classifyWebhookEvent(provider, k) === "supported");
}
