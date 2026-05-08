import { describe, expect, it } from "vitest";
import {
  createWebhookRenewalLoop,
  type RenewalScheduler,
} from "../../src/core/webhookRenewalLoop.js";
import type { WebhookSubscription } from "../../src/core/webhookAutoRenewal.js";

interface ManualTimerCall {
  fired: boolean;
  delayMs: number;
  fire: () => void;
}

function makeManualScheduler(): { scheduler: RenewalScheduler; pending: ManualTimerCall[] } {
  const pending: ManualTimerCall[] = [];
  const scheduler: RenewalScheduler = {
    setTimer(cb, delayMs): ManualTimerCall {
      const entry: ManualTimerCall = {
        fired: false,
        delayMs,
        fire: (): void => {
          if (entry.fired) return;
          entry.fired = true;
          cb();
        },
      };
      pending.push(entry);
      return entry;
    },
    clearTimer(handle): void {
      if (handle && typeof handle === "object") {
        (handle as ManualTimerCall).fired = true;
      }
    },
  };
  return { scheduler, pending };
}

const NOW = 1_700_000_000_000;
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

describe("createWebhookRenewalLoop — start triggers initial tick", () => {
  it("fetches subscriptions on start and schedules next via wait_until", async () => {
    const { scheduler, pending } = makeManualScheduler();
    const subs: WebhookSubscription[] = [
      { id: "s1", expiresAtIso: iso(2 * 60 * 60 * 1000) }, // 2h → wait_until
    ];
    const loop = createWebhookRenewalLoop({
      fetchSubscriptions: () => Promise.resolve(subs),
      onRenew: () => undefined,
      onRecreate: () => undefined,
      now: () => NOW,
      scheduler,
    });
    loop.start();
    // Allow the tick promise to resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0]?.delayMs).toBeGreaterThan(60_000); // > minTick
    loop.dispose();
  });
});

describe("createWebhookRenewalLoop — invokes onRenew for renew_now subscriptions", () => {
  it("fires onRenew when expiry is within slack window", async () => {
    const { scheduler } = makeManualScheduler();
    const renewed: string[] = [];
    const loop = createWebhookRenewalLoop({
      fetchSubscriptions: () => Promise.resolve([{ id: "s1", expiresAtIso: iso(5 * 60_000) }]),
      onRenew: (s) => {
        renewed.push(s.id);
      },
      onRecreate: () => undefined,
      now: () => NOW,
      scheduler,
    });
    loop.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(renewed).toEqual(["s1"]);
    loop.dispose();
  });
});

describe("createWebhookRenewalLoop — invokes onRecreate for expired", () => {
  it("fires onRecreate for past-expiry subscriptions", async () => {
    const { scheduler } = makeManualScheduler();
    const recreated: string[] = [];
    const loop = createWebhookRenewalLoop({
      fetchSubscriptions: () => Promise.resolve([{ id: "expired", expiresAtIso: iso(-10) }]),
      onRenew: () => undefined,
      onRecreate: (s) => {
        recreated.push(s.id);
      },
      now: () => NOW,
      scheduler,
    });
    loop.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(recreated).toEqual(["expired"]);
    loop.dispose();
  });
});

describe("createWebhookRenewalLoop — error swallowing + logging", () => {
  it("logs onRenew errors but does not crash the loop", async () => {
    const { scheduler } = makeManualScheduler();
    const logs: string[] = [];
    const loop = createWebhookRenewalLoop({
      fetchSubscriptions: () => Promise.resolve([{ id: "s1", expiresAtIso: iso(5 * 60_000) }]),
      onRenew: () => {
        throw new Error("provider down");
      },
      onRecreate: () => undefined,
      onLog: (line) => logs.push(line),
      now: () => NOW,
      scheduler,
    });
    loop.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(logs.some((l) => l.includes("onRenew threw"))).toBe(true);
    loop.dispose();
  });

  it("logs fetchSubscriptions errors and re-schedules at minTick", async () => {
    const { scheduler, pending } = makeManualScheduler();
    const logs: string[] = [];
    const loop = createWebhookRenewalLoop({
      fetchSubscriptions: () => Promise.reject(new Error("network")),
      onRenew: () => undefined,
      onRecreate: () => undefined,
      onLog: (line) => logs.push(line),
      now: () => NOW,
      scheduler,
    });
    loop.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(logs.some((l) => l.includes("fetch failed"))).toBe(true);
    expect(pending[0]?.delayMs).toBe(60_000);
    loop.dispose();
  });
});

describe("createWebhookRenewalLoop — dispose stops further ticks", () => {
  it("isRunning is false after dispose", () => {
    const { scheduler } = makeManualScheduler();
    const loop = createWebhookRenewalLoop({
      fetchSubscriptions: () => Promise.resolve([]),
      onRenew: () => undefined,
      onRecreate: () => undefined,
      now: () => NOW,
      scheduler,
    });
    loop.start();
    expect(loop.isRunning()).toBe(true);
    loop.dispose();
    expect(loop.isRunning()).toBe(false);
  });
});
