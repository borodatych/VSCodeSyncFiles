/**
 * v2.1.3 — pure step planner for the `vscodesync.startP2PSession`
 * multi-step QuickPick. Mirrors the orchestration shape used by
 * `keyRotationWizardSteps.ts` / `bulkPushAiReviewFlow.ts`:
 * UI walks the returned `steps[]` linearly; the planner decides
 * which steps to include for inviter vs invitee + the air-gap
 * (QR) variant.
 *
 * No `vscode` import. No transport / WebRTC code here.
 */

export type P2PSessionRole = "inviter" | "invitee";

export type P2PSessionTransport = "cloud" | "qr";

export type P2PSessionStep =
  | "pick_role"
  | "pick_target_machine"
  | "pick_active_session"
  | "generate_offer"
  | "exchange_offer_qr"
  | "exchange_answer_qr"
  | "wait_for_answer"
  | "decode_offer_qr"
  | "generate_answer"
  | "ice_exchange"
  | "connection_established"
  | "abort_no_peers";

export interface P2PSessionFlowPlan {
  role: P2PSessionRole;
  transport: P2PSessionTransport;
  steps: P2PSessionStep[];
  warnings: P2PSessionWarning[];
}

export type P2PSessionWarning =
  | "no_online_peers"
  | "no_active_invites"
  | "qr_oversized_payload"
  | "transport_fallback_to_qr";

export interface PlanP2PSessionInput {
  role: P2PSessionRole;
  /** Whether at least one signaling-capable peer is online. Drives the
   * `no_online_peers` warning + the `abort_no_peers` step on inviter side. */
  onlinePeerCount: number;
  /** Whether any active session signaling envelope exists in cloud root.
   * Only relevant on invitee side. */
  activeSessionCount: number;
  /** When user explicitly forced QR (air-gapped pair) OR cloud signaling
   * is unavailable on this provider. */
  forceQrTransport?: boolean;
  /** Whether the cloud signaling channel is writable here (read-only
   * provider → must use QR). */
  cloudSignalingWritable?: boolean;
  /** Approximate bytes of the signaling payload — when above
   * `qrChunkLimitBytes * 4` the user gets the qr_oversized_payload
   * warning. Default chunk limit 1500. */
  estimatedSignalingPayloadBytes?: number;
  qrChunkLimitBytes?: number;
}

const DEFAULT_QR_CHUNK_LIMIT_BYTES = 1500;

export function planP2PSessionWizard(input: PlanP2PSessionInput): P2PSessionFlowPlan {
  const transport = decideTransport(input);
  const warnings = collectWarnings(input, transport);
  const steps = buildSteps(input, transport);
  return { role: input.role, transport, steps, warnings };
}

function decideTransport(input: PlanP2PSessionInput): P2PSessionTransport {
  if (input.forceQrTransport === true) return "qr";
  if (input.cloudSignalingWritable === false) return "qr";
  return "cloud";
}

function collectWarnings(
  input: PlanP2PSessionInput,
  transport: P2PSessionTransport,
): P2PSessionWarning[] {
  const w: P2PSessionWarning[] = [];
  if (input.role === "inviter" && input.onlinePeerCount === 0) {
    w.push("no_online_peers");
  }
  if (input.role === "invitee" && input.activeSessionCount === 0 && transport === "cloud") {
    w.push("no_active_invites");
  }
  if (transport === "qr") {
    const limit = input.qrChunkLimitBytes ?? DEFAULT_QR_CHUNK_LIMIT_BYTES;
    if (
      input.estimatedSignalingPayloadBytes !== undefined &&
      input.estimatedSignalingPayloadBytes > limit * 4
    ) {
      w.push("qr_oversized_payload");
    }
    if (input.cloudSignalingWritable === false) {
      w.push("transport_fallback_to_qr");
    }
  }
  return w;
}

function buildSteps(
  input: PlanP2PSessionInput,
  transport: P2PSessionTransport,
): P2PSessionStep[] {
  if (input.role === "inviter") {
    if (input.onlinePeerCount === 0 && transport === "cloud") {
      return ["pick_role", "abort_no_peers"];
    }
    if (transport === "qr") {
      return [
        "pick_role",
        "generate_offer",
        "exchange_offer_qr",
        "exchange_answer_qr",
        "ice_exchange",
        "connection_established",
      ];
    }
    return [
      "pick_role",
      "pick_target_machine",
      "generate_offer",
      "wait_for_answer",
      "ice_exchange",
      "connection_established",
    ];
  }
  // invitee
  if (transport === "qr") {
    return [
      "pick_role",
      "decode_offer_qr",
      "generate_answer",
      "exchange_answer_qr",
      "ice_exchange",
      "connection_established",
    ];
  }
  if (input.activeSessionCount === 0) {
    return ["pick_role", "abort_no_peers"];
  }
  return [
    "pick_role",
    "pick_active_session",
    "generate_answer",
    "ice_exchange",
    "connection_established",
  ];
}
