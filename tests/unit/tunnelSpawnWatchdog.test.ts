import { describe, expect, it } from "vitest";
import {
  createTunnelSpawnWatchdog,
  SPAWN_WATCHDOG_DEFAULT_INITIAL_DELAY_MS,
  SPAWN_WATCHDOG_DEFAULT_MAX_ATTEMPTS,
} from "../../src/core/tunnelSpawnWatchdog.js";

const NOW = 1_700_000_000_000;

describe("createTunnelSpawnWatchdog — defaults", () => {
  it("starts in idle", () => {
    const w = createTunnelSpawnWatchdog();
    expect(w.state.kind).toBe("idle");
  });

  it("rejects invalid options", () => {
    expect(() => createTunnelSpawnWatchdog({ maxAttempts: 0 })).toThrow();
    expect(() => createTunnelSpawnWatchdog({ initialDelayMs: 0 })).toThrow();
    expect(() => createTunnelSpawnWatchdog({ initialDelayMs: 1000, maxDelayMs: 500 })).toThrow();
    expect(() => createTunnelSpawnWatchdog({ backoffFactor: 0 })).toThrow();
  });

  it("exposes documented defaults", () => {
    expect(SPAWN_WATCHDOG_DEFAULT_MAX_ATTEMPTS).toBe(3);
    expect(SPAWN_WATCHDOG_DEFAULT_INITIAL_DELAY_MS).toBe(1_000);
  });
});

describe("createTunnelSpawnWatchdog — happy path", () => {
  it("idle → spawning → up via spawn_now / wait_for_url / ready", () => {
    const w = createTunnelSpawnWatchdog();
    const d1 = w.onStart(NOW);
    expect(d1.kind).toBe("spawn_now");
    if (d1.kind !== "spawn_now") throw new Error();
    expect(d1.attempt).toBe(1);
    expect(w.state.kind).toBe("spawning");

    expect(w.onSpawned(NOW + 100).kind).toBe("wait_for_url");
    const d3 = w.onUrlObserved(NOW + 200, "https://abc.trycloudflare.com");
    expect(d3.kind).toBe("ready");
    expect(w.state.kind).toBe("up");
    if (w.state.kind !== "up") throw new Error();
    expect(w.state.url).toBe("https://abc.trycloudflare.com");
  });

  it("onStart is idempotent while spawning / up", () => {
    const w = createTunnelSpawnWatchdog();
    w.onStart(NOW);
    expect(w.onStart(NOW + 1).kind).toBe("noop");
    w.onSpawned(NOW + 100);
    w.onUrlObserved(NOW + 200, "https://x.trycloudflare.com");
    expect(w.onStart(NOW + 300).kind).toBe("noop");
  });
});

describe("createTunnelSpawnWatchdog — respawn paths", () => {
  it("url_timeout schedules respawn with exponential backoff", () => {
    const w = createTunnelSpawnWatchdog({
      initialDelayMs: 1000,
      maxDelayMs: 30_000,
      backoffFactor: 2,
      maxAttempts: 3,
    });
    w.onStart(NOW);
    const r = w.onUrlTimeout(NOW + 30_000);
    if (r.kind !== "respawn_after") throw new Error();
    expect(r.attempt).toBe(2);
    expect(r.delayMs).toBe(2000); // 1000 * 2^(2-1)
    expect(r.reason).toBe("url_timeout");
    expect(w.state.kind).toBe("respawning");
  });

  it("process_exit when up demotes to respawning", () => {
    const w = createTunnelSpawnWatchdog();
    w.onStart(NOW);
    w.onSpawned(NOW + 100);
    w.onUrlObserved(NOW + 200, "https://x.trycloudflare.com");
    const r = w.onProcessExit(NOW + 1000);
    if (r.kind !== "respawn_after") throw new Error();
    expect(r.attempt).toBe(2);
    expect(r.reason).toBe("process_exit");
  });

  it("spawn_failed counts as a failed attempt", () => {
    const w = createTunnelSpawnWatchdog();
    w.onStart(NOW);
    const r = w.onSpawnFailed(NOW);
    if (r.kind !== "respawn_after") throw new Error();
    expect(r.reason).toBe("spawn_failed");
  });

  it("re-onStart from respawning advances to spawning with the same attempt", () => {
    const w = createTunnelSpawnWatchdog();
    w.onStart(NOW);
    w.onUrlTimeout(NOW); // → respawning attempt 2
    if (w.state.kind !== "respawning") throw new Error();
    expect(w.state.attempt).toBe(2);
    const next = w.onStart(NOW + 5_000);
    if (next.kind !== "spawn_now") throw new Error();
    expect(next.attempt).toBe(2);
  });

  it("delays cap at maxDelayMs", () => {
    const w = createTunnelSpawnWatchdog({
      initialDelayMs: 1000,
      maxDelayMs: 4_500,
      backoffFactor: 2,
      maxAttempts: 100,
    });
    w.onStart(NOW);
    let r = w.onUrlTimeout(NOW); // attempt 2
    if (r.kind !== "respawn_after") throw new Error();
    expect(r.delayMs).toBe(2_000);
    w.onStart(NOW);
    r = w.onUrlTimeout(NOW); // attempt 3
    if (r.kind !== "respawn_after") throw new Error();
    expect(r.delayMs).toBe(4_000);
    w.onStart(NOW);
    r = w.onUrlTimeout(NOW); // attempt 4 — would be 8_000, capped to 4_500
    if (r.kind !== "respawn_after") throw new Error();
    expect(r.delayMs).toBe(4_500);
  });
});

describe("createTunnelSpawnWatchdog — give-up", () => {
  it("transitions to giveup once attempts hit maxAttempts", () => {
    const w = createTunnelSpawnWatchdog({ maxAttempts: 2, initialDelayMs: 1000 });
    w.onStart(NOW);
    w.onUrlTimeout(NOW); // attempt 2
    w.onStart(NOW);
    const r = w.onUrlTimeout(NOW); // attempt 2 already, would be 3 → give_up
    if (r.kind !== "give_up") throw new Error();
    expect(r.attempts).toBe(2);
    expect(w.state.kind).toBe("giveup");
  });

  it("give_up records the failure reason that pushed it over the line", () => {
    const w = createTunnelSpawnWatchdog({ maxAttempts: 1 });
    w.onStart(NOW);
    const r = w.onProcessExit(NOW); // attempt is already at maxAttempts → give_up
    if (r.kind !== "give_up") throw new Error();
    expect(r.reason).toBe("process_exit");
  });

  it("subsequent events after give_up are noops (the watchdog is dead)", () => {
    const w = createTunnelSpawnWatchdog({ maxAttempts: 1 });
    w.onStart(NOW);
    w.onProcessExit(NOW);
    expect(w.onUrlTimeout(NOW + 1).kind).toBe("noop");
    expect(w.onSpawnFailed(NOW + 1).kind).toBe("noop");
    expect(w.onProcessExit(NOW + 1).kind).toBe("noop");
  });
});

describe("createTunnelSpawnWatchdog — dispose", () => {
  it("stops from any active state and returns to idle", () => {
    const w = createTunnelSpawnWatchdog();
    w.onStart(NOW);
    expect(w.onDispose(NOW + 1).kind).toBe("stop");
    expect(w.state.kind).toBe("idle");
  });

  it("dispose from idle is a noop", () => {
    const w = createTunnelSpawnWatchdog();
    expect(w.onDispose(NOW).kind).toBe("noop");
  });
});
