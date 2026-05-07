/**
 * Token-expiry hints — detect when a refresh token is about to expire so the
 * UI can ask the user to re-auth before the next sync silently fails.
 *
 * Wired into `extension.ts` startup-loop for OneDrive (which lacks
 * auto-refresh); other providers can opt in once we decide which timestamp
 * to persist (refresh-token TTL vs access-token).
 *
 * Different providers have different refresh-token TTLs:
 *  - OneDrive: refresh tokens don't strictly expire on long-lived auth, but
 *    inactivity > 90d invalidates them.
 *  - Google Drive: 7d for "testing" OAuth apps, 6mo otherwise.
 *  - Dropbox: refresh tokens valid until revoked.
 *  - Yandex.Disk: 1y by default, returned in `expires_in` of the OAuth payload.
 *
 * The `expiresAtMs` we already store usually applies to the access token, not
 * the refresh token. To keep the surface minimal, this helper takes whatever
 * "session-end" timestamp the caller has and decides whether to warn.
 *
 * vscode-free: testable in isolation. The UI layer surfaces the hint as a
 * `showWarningMessage` near startup.
 */

export const DEFAULT_EXPIRY_WARN_DAYS = 7;
export const MS_PER_DAY = 24 * 3600_000;

export interface ExpiryHintOptions {
  /** Window in days before expiry that should trigger the warning. */
  warnWithinDays?: number;
  /** Time anchor — pass `Date.now()` in production, fixed value in tests. */
  now?: number;
}

export type ExpiryHint =
  | { kind: "ok" }
  | { kind: "expired"; daysSinceExpiry: number }
  | { kind: "expiring_soon"; daysUntilExpiry: number };

export function classifyExpiry(
  expiresAtMs: number | undefined,
  opts: ExpiryHintOptions = {},
): ExpiryHint {
  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) return { kind: "ok" };
  const now = opts.now ?? Date.now();
  const warnDays = opts.warnWithinDays ?? DEFAULT_EXPIRY_WARN_DAYS;
  const diffMs = expiresAtMs - now;
  if (diffMs <= 0) {
    return { kind: "expired", daysSinceExpiry: Math.floor(-diffMs / MS_PER_DAY) };
  }
  if (diffMs <= warnDays * MS_PER_DAY) {
    return { kind: "expiring_soon", daysUntilExpiry: Math.ceil(diffMs / MS_PER_DAY) };
  }
  return { kind: "ok" };
}

/** Human-readable message for the toast. */
export function formatExpiryHint(provider: string, hint: ExpiryHint): string | null {
  if (hint.kind === "ok") return null;
  if (hint.kind === "expired") {
    return `VSCodeSync: сессия ${provider} просрочена ${String(hint.daysSinceExpiry)} дн. назад — войдите снова.`;
  }
  return `VSCodeSync: сессия ${provider} истекает через ${String(hint.daysUntilExpiry)} дн. — рекомендуем переавторизоваться заранее.`;
}
