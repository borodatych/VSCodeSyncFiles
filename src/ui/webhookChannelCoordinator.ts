import * as vscode from "vscode";
import { shouldSuppressWatchPollingFromSilencePolicy } from "./webhookWatchModePolicy.js";

const CFG = "vscodesync";

export type WebhookPushProviderKind = "none" | "onedrive" | "gdrive";

let activePushProvider: WebhookPushProviderKind = "none";
let subscriptionActivatedAtMs = 0;
let lastNotificationAtMs = 0;

/** Stop push-based watch suppression only if this extension instance owns it. */
export function deactivateWebhookPushIfProvider(provider: WebhookPushProviderKind): void {
  if (activePushProvider === provider) {
    activePushProvider = "none";
    subscriptionActivatedAtMs = 0;
    lastNotificationAtMs = 0;
  }
}

export function activateWebhookPushFor(provider: Exclude<WebhookPushProviderKind, "none">): void {
  activePushProvider = provider;
  const now = Date.now();
  subscriptionActivatedAtMs = now;
  lastNotificationAtMs = now;
}

export function recordWebhookPushNotification(): void {
  lastNotificationAtMs = Date.now();
}

export function isWebhookPushChannelActive(): boolean {
  return activePushProvider !== "none";
}

/** Legacy name: OneDrive Graph subscription or Google Drive channel. */
export function isWebhookSubscriptionActive(): boolean {
  return isWebhookPushChannelActive();
}

export function isWebhookWatchPollingSuppressed(): boolean {
  const cfg = vscode.workspace.getConfiguration(CFG);
  return shouldSuppressWatchPollingFromSilencePolicy({
    lifecycleActive: activePushProvider !== "none",
    webhooksEnabled: cfg.get<boolean>("webhooks.enabled", false),
    fallbackAfterMinutes: cfg.get<number>("webhooks.fallbackAfterMinutes", 5),
    lastNotificationAtMs,
    subscriptionActivatedAtMs,
    nowMs: Date.now(),
  });
}
