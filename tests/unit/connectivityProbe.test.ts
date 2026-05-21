import { describe, expect, it } from "vitest";
import {
  INITIAL_STATE,
  decayConnectivity,
  describeConnectivity,
  noteProbeFailure,
  noteProbeSuccess,
  shouldSuppressAutoSync,
} from "../../src/core/connectivityProbe.js";

describe("connectivityProbe", () => {
  it("initial state is unknown", () => {
    expect(INITIAL_STATE.status).toBe("unknown");
    expect(INITIAL_STATE.consecutiveFailures).toBe(0);
  });

  it("first success → online", () => {
    const s = noteProbeSuccess(INITIAL_STATE, 1000);
    expect(s.status).toBe("online");
    expect(s.lastSuccessMs).toBe(1000);
  });

  it("2 failures → degraded (default threshold)", () => {
    let s = noteProbeFailure(INITIAL_STATE, 100);
    expect(s.status).toBe("unknown"); // 1 failure, below threshold
    s = noteProbeFailure(s, 200);
    expect(s.status).toBe("degraded");
  });

  it("4 failures → offline", () => {
    let s = INITIAL_STATE;
    for (let i = 1; i <= 4; i++) s = noteProbeFailure(s, i * 100);
    expect(s.status).toBe("offline");
    expect(s.consecutiveFailures).toBe(4);
  });

  it("success after failures resets to online + zero counter", () => {
    let s = INITIAL_STATE;
    for (let i = 0; i < 5; i++) s = noteProbeFailure(s, 100 + i);
    expect(s.status).toBe("offline");
    s = noteProbeSuccess(s, 500);
    expect(s.status).toBe("online");
    expect(s.consecutiveFailures).toBe(0);
  });

  it("decay: online > 30s without success → degraded", () => {
    const s = noteProbeSuccess(INITIAL_STATE, 1000);
    expect(decayConnectivity(s, 5_000).status).toBe("online"); // <30s
    expect(decayConnectivity(s, 100_000).status).toBe("degraded");
  });

  it("shouldSuppressAutoSync only on offline", () => {
    const online = noteProbeSuccess(INITIAL_STATE, 1000);
    expect(shouldSuppressAutoSync(online)).toBe(false);
    const offline = (() => {
      let s = INITIAL_STATE;
      for (let i = 0; i < 5; i++) s = noteProbeFailure(s, i);
      return s;
    })();
    expect(shouldSuppressAutoSync(offline)).toBe(true);
  });

  it("describeConnectivity returns non-empty per status", () => {
    const states = [
      INITIAL_STATE,
      noteProbeSuccess(INITIAL_STATE, 1000),
      noteProbeFailure(noteProbeFailure(INITIAL_STATE, 1), 2),
      (() => {
        let s = INITIAL_STATE;
        for (let i = 0; i < 5; i++) s = noteProbeFailure(s, i);
        return s;
      })(),
    ];
    for (const s of states) {
      expect(describeConnectivity(s, 10_000).length).toBeGreaterThan(0);
    }
  });
});
