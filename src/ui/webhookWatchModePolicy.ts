/**
 * Watch Mode: suppress interval polling while Graph webhooks are assumed healthy.
 * If no notification arrives within fallbackAfterMinutes (after an initial grace of the same length),
 * polling resumes so changes are not missed when the push channel is silent or broken.
 */
export function shouldSuppressWatchPollingFromSilencePolicy(args: {
  lifecycleActive: boolean;
  webhooksEnabled: boolean;
  /** 0 = never fall back on silence (always suppress polling when lifecycle is active). */
  fallbackAfterMinutes: number;
  lastNotificationAtMs: number;
  subscriptionActivatedAtMs: number;
  nowMs: number;
}): boolean {
  if (!args.webhooksEnabled || !args.lifecycleActive) {
    return false;
  }
  if (args.fallbackAfterMinutes <= 0) {
    return true;
  }
  const fbMs = args.fallbackAfterMinutes * 60_000;
  if (args.nowMs - args.subscriptionActivatedAtMs < fbMs) {
    return true;
  }
  if (args.nowMs - args.lastNotificationAtMs > fbMs) {
    return false;
  }
  return true;
}
