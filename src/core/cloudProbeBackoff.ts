/**
 * How often background pollers may touch an unreachable cloud.
 *
 * Measured on a real workday (VibeIDE logs, 18–19.09.2026): with the cloud
 * blocked at the network perimeter, every connect attempt hung for undici's
 * 10 s connect timeout — and the pollers kept starting a new one every minute,
 * all day, producing 147 failed requests and nothing else. Nobody was served
 * by any of them: the answer was already known after the first.
 *
 * So this is the reading counterpart of `syncOfflineFlushBackoff`, which does
 * the same for the outbound queue. Two policies rather than one shared timer on
 * purpose: sending what the user already asked for and polling on our own
 * initiative recover differently, and collapsing them would make a failed probe
 * delay the user's queued push.
 *
 * Probing never stops entirely — it thins out to one attempt per 5 minutes.
 * Silence would be worse than noise: the cloud coming back must be noticed
 * without the user doing anything.
 */
import { ExponentialBackoff } from "./exponentialBackoff.js";
import {
  hasStickyUnreachableHint,
  onCloudTransportSuccess,
  subscribeOfflineHints,
} from "./syncOfflineHints.js";

const INITIAL_DELAY_MS = 15_000;
const FACTOR = 2;
const MAX_DELAY_MS = 300_000;

/**
 * One `withRetry` envelope reports several transport failures in a row. Without
 * this window a single dropped request would push the delay three steps at
 * once — the exact bug E12 fixed for the flush backoff.
 */
const FAILURE_DEBOUNCE_MS = 5_000;

const backoff = new ExponentialBackoff(INITIAL_DELAY_MS, FACTOR, MAX_DELAY_MS);
let nextProbeAfterMs = 0;
let lastFailureNoteMs = 0;
let onChange: ((unreachable: boolean, nextProbeInMs: number) => void) | undefined;

function noteFailure(nowMs: number): void {
  if (nowMs - lastFailureNoteMs < FAILURE_DEBOUNCE_MS) {
    return;
  }
  lastFailureNoteMs = nowMs;
  const delay = backoff.nextDelayMs();
  nextProbeAfterMs = Math.max(nextProbeAfterMs, nowMs + delay);
  onChange?.(true, delay);
}

function noteRecovered(): void {
  if (nextProbeAfterMs === 0 && lastFailureNoteMs === 0) {
    return;
  }
  backoff.reset();
  nextProbeAfterMs = 0;
  lastFailureNoteMs = 0;
  onChange?.(false, 0);
}

subscribeOfflineHints(() => {
  if (hasStickyUnreachableHint()) {
    noteFailure(Date.now());
  }
});

onCloudTransportSuccess(() => {
  noteRecovered();
});

/**
 * May a background poller reach for the cloud right now?
 *
 * `true` whenever the cloud is believed reachable, and once per backoff window
 * while it is not — that single attempt is what detects recovery.
 */
export function cloudProbeAllowedNow(nowMs: number = Date.now()): boolean {
  return nowMs >= nextProbeAfterMs;
}

/** Milliseconds until the next allowed probe; `0` when one may run now. */
export function msUntilNextCloudProbe(nowMs: number = Date.now()): number {
  return Math.max(0, nextProbeAfterMs - nowMs);
}

/**
 * Report transitions (entering the thinned-out mode and leaving it). The UI
 * layer wires a log line here: a day of silence with no explanation is exactly
 * what made the original diagnosis take a log archaeology session.
 */
export function setCloudProbeBackoffListener(
  listener: ((unreachable: boolean, nextProbeInMs: number) => void) | undefined,
): void {
  onChange = listener;
}

export function resetCloudProbeBackoffForTests(): void {
  backoff.reset();
  nextProbeAfterMs = 0;
  lastFailureNoteMs = 0;
  onChange = undefined;
}
