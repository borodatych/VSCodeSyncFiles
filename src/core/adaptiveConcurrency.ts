/**
 * v0.17 N20 — pure decision for adaptive sync concurrency.
 *
 * Lowers concurrency when:
 *   - battery < 20% (and not plugged in)
 *   - RAM usage > 75%
 *   - recent 429/503 rate-limit (already tracked by syncRateLimitState)
 *   - CPU sustained > 80% for >30s (caller measures)
 *
 * Multiplier `0..1` is applied to user's configured `sync.concurrency`;
 * we never go below 1.
 */

export type ConcurrencyPressureKind =
  | "battery_low"
  | "battery_critical"
  | "ram_high"
  | "rate_limited"
  | "cpu_high";

export interface ConcurrencyPressureInput {
  /** 0..100, undefined when no battery (desktop). */
  batteryPercent?: number;
  /** True when the laptop is on AC power. */
  pluggedIn?: boolean;
  /** 0..1 — RAM in use over total. */
  ramRatio?: number;
  /** True when last provider response was 429/503 within cooldown. */
  rateLimited?: boolean;
  /** True when sustained CPU > 80% for last 30s. */
  cpuHigh?: boolean;
}

export interface ConcurrencyDecision {
  /** Resulting cap; never below 1. */
  resolvedConcurrency: number;
  /** Multiplier applied to the user setting (1.0 = no change, 0.25 = aggressive). */
  multiplier: number;
  /** Why we lowered. Empty when at 1.0. */
  reasons: ConcurrencyPressureKind[];
}

export interface AdaptiveConcurrencyOptions {
  /** User setting (sync.concurrency). */
  userConcurrency: number;
}

export function decideAdaptiveConcurrency(
  input: ConcurrencyPressureInput,
  opts: AdaptiveConcurrencyOptions,
): ConcurrencyDecision {
  const reasons: ConcurrencyPressureKind[] = [];
  let multiplier = 1;

  if (input.batteryPercent !== undefined && input.pluggedIn !== true) {
    if (input.batteryPercent < 10) {
      multiplier = Math.min(multiplier, 0.25);
      reasons.push("battery_critical");
    } else if (input.batteryPercent < 20) {
      multiplier = Math.min(multiplier, 0.5);
      reasons.push("battery_low");
    }
  }
  if (input.ramRatio !== undefined && input.ramRatio > 0.75) {
    multiplier = Math.min(multiplier, 0.5);
    reasons.push("ram_high");
  }
  if (input.rateLimited === true) {
    multiplier = Math.min(multiplier, 0.5);
    reasons.push("rate_limited");
  }
  if (input.cpuHigh === true) {
    multiplier = Math.min(multiplier, 0.5);
    reasons.push("cpu_high");
  }

  const resolved = Math.max(1, Math.round(opts.userConcurrency * multiplier));
  return {
    resolvedConcurrency: resolved,
    multiplier,
    reasons,
  };
}
