import { afterEach, describe, expect, it, vi } from "vitest";
import { syncAutoPause } from "../../src/core/syncAutoPause.js";

// Module-level singleton — reset between tests.
afterEach(() => {
  syncAutoPause.commitPollingSnapshot({ metered: false, battery: false });
});

describe("syncAutoPause — getters", () => {
  it("starts inactive", () => {
    expect(syncAutoPause.isActive()).toBe(false);
    expect(syncAutoPause.isMeteredPaused()).toBe(false);
    expect(syncAutoPause.isBatteryPaused()).toBe(false);
    expect(syncAutoPause.getReason()).toBeNull();
  });
});

describe("syncAutoPause — commitPollingSnapshot", () => {
  it("sets metered flag and reports the reason", () => {
    const changed = syncAutoPause.commitPollingSnapshot({ metered: true, battery: false });
    expect(changed).toBe(true);
    expect(syncAutoPause.isMeteredPaused()).toBe(true);
    expect(syncAutoPause.isActive()).toBe(true);
    expect(syncAutoPause.getReason()).toBe("metered");
  });

  it("sets battery flag and reports the reason when no metered", () => {
    syncAutoPause.commitPollingSnapshot({ metered: false, battery: true });
    expect(syncAutoPause.getReason()).toBe("battery");
  });

  it("metered takes priority over battery in getReason", () => {
    syncAutoPause.commitPollingSnapshot({ metered: true, battery: true });
    expect(syncAutoPause.getReason()).toBe("metered");
  });

  it("returns false when combined state didn't flip", () => {
    syncAutoPause.commitPollingSnapshot({ metered: true, battery: false });
    const changed = syncAutoPause.commitPollingSnapshot({ metered: true, battery: true });
    // active stayed true; the combined() check sees no transition.
    expect(changed).toBe(false);
  });

  it("returns true when transitioning from inactive → active and back", () => {
    expect(syncAutoPause.commitPollingSnapshot({ metered: true, battery: false })).toBe(true);
    expect(syncAutoPause.commitPollingSnapshot({ metered: false, battery: false })).toBe(true);
  });
});

describe("syncAutoPause — subscribe / dispose", () => {
  it("listener fires only on combined state change", () => {
    const listener = vi.fn();
    const sub = syncAutoPause.subscribe(listener);
    syncAutoPause.commitPollingSnapshot({ metered: true, battery: false }); // 0 → 1
    syncAutoPause.commitPollingSnapshot({ metered: true, battery: true }); // still 1 — no fire
    syncAutoPause.commitPollingSnapshot({ metered: false, battery: false }); // 1 → 0
    expect(listener).toHaveBeenCalledTimes(2);
    sub.dispose();
  });

  it("disposed listener stops receiving events", () => {
    const listener = vi.fn();
    const sub = syncAutoPause.subscribe(listener);
    sub.dispose();
    syncAutoPause.commitPollingSnapshot({ metered: true, battery: false });
    expect(listener).not.toHaveBeenCalled();
  });

  it("listener that throws does not break other listeners", () => {
    const a = vi.fn(() => {
      throw new Error("boom");
    });
    const b = vi.fn();
    const subA = syncAutoPause.subscribe(a);
    const subB = syncAutoPause.subscribe(b);
    syncAutoPause.commitPollingSnapshot({ metered: true, battery: false });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    subA.dispose();
    subB.dispose();
  });
});
