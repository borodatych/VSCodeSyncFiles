import { describe, expect, it } from "vitest";
import {
  createP2PSessionMachine,
  HEARTBEAT_LIVENESS_TIMEOUT_MS,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
} from "../../src/core/p2pSessionStateMachine.js";

const T0 = 1_700_000_000_000;

describe("p2pSessionStateMachine — idle → connecting → connected", () => {
  it("transitions through start() and onConnected()", () => {
    const m = createP2PSessionMachine();
    expect(m.state.kind).toBe("idle");
    m.start(T0);
    expect(m.state.kind).toBe("connecting");
    m.onConnected(T0 + 500);
    expect(m.state.kind).toBe("connected");
    if (m.state.kind === "connected") {
      expect(m.state.lastHeartbeatAtMs).toBe(T0 + 500);
    }
    const kinds = m.events.map((e) => e.kind);
    expect(kinds).toEqual(["p2p_session_started", "p2p_session_connected"]);
  });

  it("ignores duplicate start() while already connecting/connected", () => {
    const m = createP2PSessionMachine();
    m.start(T0);
    m.start(T0 + 100);
    expect(m.events.filter((e) => e.kind === "p2p_session_started")).toHaveLength(1);
  });
});

describe("p2pSessionStateMachine — heartbeat liveness", () => {
  it("onHeartbeatTick demotes to reconnecting when no heartbeat past timeout", () => {
    const m = createP2PSessionMachine();
    m.start(T0);
    m.onConnected(T0);
    const demoted = m.onHeartbeatTick(T0 + HEARTBEAT_LIVENESS_TIMEOUT_MS + 1);
    expect(demoted).toBe(true);
    expect(m.state.kind).toBe("reconnecting");
    if (m.state.kind === "reconnecting") {
      expect(m.state.attempt).toBe(1);
      expect(m.state.nextDelayMs).toBe(RECONNECT_INITIAL_DELAY_MS);
    }
  });

  it("does not demote while heartbeats are fresh", () => {
    const m = createP2PSessionMachine();
    m.start(T0);
    m.onConnected(T0);
    m.onHeartbeatReceived(T0 + 1_000);
    const demoted = m.onHeartbeatTick(T0 + 1_000 + HEARTBEAT_LIVENESS_TIMEOUT_MS - 1);
    expect(demoted).toBe(false);
    expect(m.state.kind).toBe("connected");
  });

  it("onHeartbeatReceived updates lastHeartbeatAtMs", () => {
    const m = createP2PSessionMachine();
    m.start(T0);
    m.onConnected(T0);
    m.onHeartbeatReceived(T0 + 5_000);
    if (m.state.kind === "connected") {
      expect(m.state.lastHeartbeatAtMs).toBe(T0 + 5_000);
    }
  });
});

describe("p2pSessionStateMachine — exponential backoff", () => {
  it("each onTransportFailure doubles the delay (capped)", () => {
    const m = createP2PSessionMachine({
      reconnectInitialDelayMs: 1_000,
      reconnectMaxDelayMs: 30_000,
      reconnectBackoffFactor: 2,
      reconnectMaxAttempts: 10,
    });
    m.start(T0);
    m.onConnected(T0);
    m.onTransportFailure(T0, "x");
    expect(m.state.kind === "reconnecting" && m.state.attempt).toBe(1);
    expect(m.state.kind === "reconnecting" && m.state.nextDelayMs).toBe(1_000);
    m.onTransportFailure(T0 + 1_000, "x");
    expect(m.state.kind === "reconnecting" && m.state.nextDelayMs).toBe(2_000);
    m.onTransportFailure(T0 + 2_000, "x");
    expect(m.state.kind === "reconnecting" && m.state.nextDelayMs).toBe(4_000);
  });

  it("gives up after RECONNECT_MAX_ATTEMPTS and ends session", () => {
    const m = createP2PSessionMachine({ reconnectMaxAttempts: 2 });
    m.start(T0);
    m.onConnected(T0);
    m.onTransportFailure(T0, "net1");
    m.onTransportFailure(T0 + 1_000, "net2");
    m.onTransportFailure(T0 + 2_000, "net3"); // exceeds max
    expect(m.state.kind).toBe("disconnected");
    if (m.state.kind === "disconnected") {
      expect(m.state.reason).toBe("net3");
    }
    expect(m.events.some((e) => e.kind === "p2p_session_reconnect_giveup")).toBe(true);
    expect(m.events.some((e) => e.kind === "p2p_session_ended")).toBe(true);
  });

  it("onReconnectAttemptSucceeded promotes back to connected", () => {
    const m = createP2PSessionMachine();
    m.start(T0);
    m.onConnected(T0);
    m.onTransportFailure(T0, "x");
    m.onReconnectAttemptSucceeded(T0 + 1_500);
    expect(m.state.kind).toBe("connected");
  });
});

describe("p2pSessionStateMachine — manual end", () => {
  it("end() from connected → disconnected with reason", () => {
    const m = createP2PSessionMachine();
    m.start(T0);
    m.onConnected(T0);
    m.end(T0 + 10_000, "user_action");
    expect(m.state.kind).toBe("disconnected");
    if (m.state.kind === "disconnected") {
      expect(m.state.reason).toBe("user_action");
    }
  });

  it("end() from idle is a no-op", () => {
    const m = createP2PSessionMachine();
    m.end(T0, "x");
    expect(m.state.kind).toBe("idle");
    expect(m.events).toHaveLength(0);
  });

  it("RECONNECT_MAX_ATTEMPTS const is in expected ballpark", () => {
    expect(RECONNECT_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(RECONNECT_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
