import { describe, expect, it } from "vitest";
import { planP2PSessionWizard } from "../../src/core/p2pSessionWizardSteps.js";

describe("planP2PSessionWizard — inviter happy path (cloud)", () => {
  it("returns 6-step cloud flow when peers are online", () => {
    const r = planP2PSessionWizard({
      role: "inviter",
      onlinePeerCount: 3,
      activeSessionCount: 0,
    });
    expect(r.transport).toBe("cloud");
    expect(r.steps).toEqual([
      "pick_role",
      "pick_target_machine",
      "generate_offer",
      "wait_for_answer",
      "ice_exchange",
      "connection_established",
    ]);
    expect(r.warnings).toEqual([]);
  });
});

describe("planP2PSessionWizard — inviter no peers", () => {
  it("aborts with reason warning when zero online peers (cloud transport)", () => {
    const r = planP2PSessionWizard({
      role: "inviter",
      onlinePeerCount: 0,
      activeSessionCount: 0,
    });
    expect(r.steps).toEqual(["pick_role", "abort_no_peers"]);
    expect(r.warnings).toContain("no_online_peers");
  });
});

describe("planP2PSessionWizard — inviter QR (air-gapped)", () => {
  it("forces QR variant when forceQrTransport=true", () => {
    const r = planP2PSessionWizard({
      role: "inviter",
      onlinePeerCount: 0,
      activeSessionCount: 0,
      forceQrTransport: true,
    });
    expect(r.transport).toBe("qr");
    expect(r.steps).toEqual([
      "pick_role",
      "generate_offer",
      "exchange_offer_qr",
      "exchange_answer_qr",
      "ice_exchange",
      "connection_established",
    ]);
  });

  it("falls back to QR when cloud signaling is read-only", () => {
    const r = planP2PSessionWizard({
      role: "inviter",
      onlinePeerCount: 1,
      activeSessionCount: 0,
      cloudSignalingWritable: false,
    });
    expect(r.transport).toBe("qr");
    expect(r.warnings).toContain("transport_fallback_to_qr");
  });

  it("warns qr_oversized_payload when payload would exceed 4 chunks", () => {
    const r = planP2PSessionWizard({
      role: "inviter",
      onlinePeerCount: 0,
      activeSessionCount: 0,
      forceQrTransport: true,
      estimatedSignalingPayloadBytes: 8000,
    });
    expect(r.warnings).toContain("qr_oversized_payload");
  });

  it("respects a caller-supplied qrChunkLimitBytes override", () => {
    const r = planP2PSessionWizard({
      role: "inviter",
      onlinePeerCount: 0,
      activeSessionCount: 0,
      forceQrTransport: true,
      estimatedSignalingPayloadBytes: 5000,
      qrChunkLimitBytes: 1000,
    });
    expect(r.warnings).toContain("qr_oversized_payload");
  });
});

describe("planP2PSessionWizard — invitee happy path (cloud)", () => {
  it("returns 5-step cloud flow when active sessions exist", () => {
    const r = planP2PSessionWizard({
      role: "invitee",
      onlinePeerCount: 0,
      activeSessionCount: 2,
    });
    expect(r.transport).toBe("cloud");
    expect(r.steps).toEqual([
      "pick_role",
      "pick_active_session",
      "generate_answer",
      "ice_exchange",
      "connection_established",
    ]);
  });
});

describe("planP2PSessionWizard — invitee no active invites", () => {
  it("aborts with no_active_invites warning when activeSessionCount=0", () => {
    const r = planP2PSessionWizard({
      role: "invitee",
      onlinePeerCount: 0,
      activeSessionCount: 0,
    });
    expect(r.steps).toEqual(["pick_role", "abort_no_peers"]);
    expect(r.warnings).toContain("no_active_invites");
  });
});

describe("planP2PSessionWizard — invitee QR", () => {
  it("uses 6-step QR flow ending in connection_established", () => {
    const r = planP2PSessionWizard({
      role: "invitee",
      onlinePeerCount: 0,
      activeSessionCount: 0,
      forceQrTransport: true,
    });
    expect(r.steps).toEqual([
      "pick_role",
      "decode_offer_qr",
      "generate_answer",
      "exchange_answer_qr",
      "ice_exchange",
      "connection_established",
    ]);
  });

  it("does not raise no_active_invites in QR transport (it's irrelevant)", () => {
    const r = planP2PSessionWizard({
      role: "invitee",
      onlinePeerCount: 0,
      activeSessionCount: 0,
      forceQrTransport: true,
    });
    expect(r.warnings).not.toContain("no_active_invites");
  });
});
