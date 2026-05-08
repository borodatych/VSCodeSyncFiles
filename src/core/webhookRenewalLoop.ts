/**
 * v2.10.2 — pure renewal loop driver.
 *
 * Wraps `planWebhookRenewal` into a callback-driven loop the engine can
 * subscribe to. Tests inject a fake timer; production wires `setTimeout`.
 *
 *   const loop = createWebhookRenewalLoop({
 *     fetchSubscriptions: async () => [...],
 *     onRenew: (sub) => { ... },
 *     onRecreate: (sub) => { ... },
 *     onLog: (line) => outputChannel.appendLine(line),
 *     scheduler: { setTimer, clearTimer } // injectable
 *   });
 *   loop.start();
 *   // later:
 *   loop.dispose();
 *
 * No `vscode` import.
 */
import { planWebhookRenewal, type WebhookSubscription } from "./webhookAutoRenewal.js";

export interface RenewalScheduler {
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface CreateRenewalLoopOptions {
  /** Caller fetches the current subscription list (sync may need provider call). */
  fetchSubscriptions: () => Promise<WebhookSubscription[]>;
  /** Called per `renew_now` action. Caller does the real provider call. */
  onRenew: (subscription: WebhookSubscription) => Promise<void> | void;
  /** Called per `expired_recreate` action. */
  onRecreate: (subscription: WebhookSubscription) => Promise<void> | void;
  /** Append-only logger (typed channel). */
  onLog?: (line: string) => void;
  /** Override Date.now() for tests. */
  now?: () => number;
  /** Override the timer for tests. */
  scheduler?: RenewalScheduler;
  /** Lower bound on the next-tick delay (default 60 s) — protects against
   * `wait_until` returning a value 0 ms in the future and stuck-looping. */
  minTickDelayMs?: number;
  /** Upper bound on the next-tick delay (default 1 hour) — caps how long we
   * sleep between checks even when no subscription is near expiry. */
  maxTickDelayMs?: number;
}

export interface RenewalLoopHandle {
  start(): void;
  dispose(): void;
  isRunning(): boolean;
}

const defaultScheduler: RenewalScheduler = {
  setTimer(cb, ms): unknown {
    const t = setTimeout(cb, ms);
    if (typeof t === "object" && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
    return t;
  },
  clearTimer(handle): void {
    if (handle !== undefined && handle !== null) {
      clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    }
  },
};

export function createWebhookRenewalLoop(opts: CreateRenewalLoopOptions): RenewalLoopHandle {
  const scheduler = opts.scheduler ?? defaultScheduler;
  const minTick = opts.minTickDelayMs ?? 60_000;
  const maxTick = opts.maxTickDelayMs ?? 60 * 60_000;
  const now = opts.now ?? ((): number => Date.now());

  let timer: unknown = null;
  let running = false;
  let disposed = false;

  const log = (line: string): void => {
    if (opts.onLog) opts.onLog(`[${new Date(now()).toISOString()}] ${line}`);
  };

  async function tick(): Promise<void> {
    if (disposed) return;
    let subs: WebhookSubscription[];
    try {
      subs = await opts.fetchSubscriptions();
    } catch (err) {
      log(`fetch failed: ${(err as Error).message}`);
      schedule(minTick);
      return;
    }
    const report = planWebhookRenewal(subs, now());
    for (const action of report.actions) {
      if (action.kind === "renew_now") {
        log(`renew_now ${action.subscription.id} (expires ${action.subscription.expiresAtIso})`);
        try {
          await opts.onRenew(action.subscription);
        } catch (err) {
          log(`onRenew threw for ${action.subscription.id}: ${(err as Error).message}`);
        }
      } else if (action.kind === "expired_recreate") {
        log(`expired_recreate ${action.subscription.id}`);
        try {
          await opts.onRecreate(action.subscription);
        } catch (err) {
          log(`onRecreate threw for ${action.subscription.id}: ${(err as Error).message}`);
        }
      }
    }
    if (report.nextWakeMs !== undefined) {
      const delay = Math.max(minTick, Math.min(maxTick, report.nextWakeMs - now()));
      schedule(delay);
    } else {
      // No wait_until items — every subscription was either renewed or
      // recreated. Re-tick at minTick to fetch fresh expiries from the
      // provider (the renew/recreate calls likely produced new ones).
      schedule(minTick);
    }
  }

  function schedule(delayMs: number): void {
    if (disposed) return;
    timer = scheduler.setTimer(() => {
      void tick();
    }, delayMs);
  }

  return {
    start(): void {
      if (running || disposed) return;
      running = true;
      void tick();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      running = false;
      scheduler.clearTimer(timer);
      timer = null;
    },
    isRunning(): boolean {
      return running && !disposed;
    },
  };
}
