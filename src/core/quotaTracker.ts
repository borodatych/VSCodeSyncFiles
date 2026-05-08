/**
 * v3.B — pure rolling-window quota tracker (per-provider, 24-hour windows by
 * default). The caller (`queuedProvider.ts` etc.) feeds in API-call timestamps
 * via `recordCall`; the tracker reports usage and threshold breaches.
 *
 * No persistence — caller serialises if needed. No `vscode` import.
 */
import type { ProviderType } from "./types.js";

export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
export const QUOTA_WARNING_RATIO = 0.7;
export const QUOTA_CRITICAL_RATIO = 0.9;
export const QUOTA_AUTO_PAUSE_RATIO = 0.95;

/** Per-provider known daily limits. Null means "unknown — never alert". */
export const PROVIDER_DAILY_LIMITS: Partial<Record<ProviderType, number | null>> = {
  onedrive: null,
  gdrive: 1_000_000_000,
  yandex: null,
  dropbox: null,
};

export type QuotaSeverity = "ok" | "warning" | "critical" | "auto_pause";

export interface QuotaSnapshot {
  provider: ProviderType;
  callsInWindow: number;
  dailyLimit: number | null;
  ratio: number;
  severity: QuotaSeverity;
}

export interface QuotaTracker {
  /** Append a call timestamp; old entries past window are evicted. */
  recordCall(provider: ProviderType, nowMs?: number): void;
  /** Return current usage snapshot for a provider. */
  snapshot(provider: ProviderType, nowMs?: number): QuotaSnapshot;
  /** Map of all tracked providers → snapshot (for the dashboard). */
  snapshotAll(nowMs?: number): QuotaSnapshot[];
}

export interface CreateQuotaTrackerOptions {
  windowMs?: number;
  /** Override per-provider limits (e.g. user has Workspace tier). */
  overrideLimits?: Partial<Record<ProviderType, number | null>>;
}

export function createQuotaTracker(opts: CreateQuotaTrackerOptions = {}): QuotaTracker {
  const windowMs = opts.windowMs ?? QUOTA_WINDOW_MS;
  const limits: Partial<Record<ProviderType, number | null>> = {
    ...PROVIDER_DAILY_LIMITS,
    ...(opts.overrideLimits ?? {}),
  };
  const calls = new Map<ProviderType, number[]>();

  function evict(provider: ProviderType, now: number): number[] {
    const arr = calls.get(provider) ?? [];
    let i = 0;
    while (i < arr.length && now - arr[i] > windowMs) i += 1;
    if (i > 0) {
      const trimmed = arr.slice(i);
      calls.set(provider, trimmed);
      return trimmed;
    }
    return arr;
  }

  function severityFor(ratio: number): QuotaSeverity {
    if (ratio >= QUOTA_AUTO_PAUSE_RATIO) return "auto_pause";
    if (ratio >= QUOTA_CRITICAL_RATIO) return "critical";
    if (ratio >= QUOTA_WARNING_RATIO) return "warning";
    return "ok";
  }

  function snapshot(provider: ProviderType, nowMs?: number): QuotaSnapshot {
    const now = nowMs ?? Date.now();
    const arr = evict(provider, now);
    const limit = limits[provider] ?? null;
    const ratio = limit === null || limit <= 0 ? 0 : arr.length / limit;
    return {
      provider,
      callsInWindow: arr.length,
      dailyLimit: limit,
      ratio: Math.min(ratio, 1),
      severity: limit === null ? "ok" : severityFor(ratio),
    };
  }

  return {
    recordCall(provider, nowMs): void {
      const now = nowMs ?? Date.now();
      const arr = calls.get(provider);
      if (arr) {
        arr.push(now);
      } else {
        calls.set(provider, [now]);
      }
      evict(provider, now);
    },
    snapshot,
    snapshotAll(nowMs): QuotaSnapshot[] {
      const out: QuotaSnapshot[] = [];
      for (const provider of calls.keys()) {
        out.push(snapshot(provider, nowMs));
      }
      return out;
    },
  };
}
