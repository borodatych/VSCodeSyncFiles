/**
 * X2 — Trusted teammates: invite-link generator + decoder — skeleton.
 *
 * The `addTrustedMachine` engine API already exists (Phase 23 W5).
 * Missing piece: a way to add a teammate's machine **without** asking
 * them to read off a 32-char machineId. We piggyback on the existing
 * `workspaceInviteLink` mechanism but encode `machineId + ttl + sig`
 * for trust enrolment instead of workspace join.
 *
 * Pure module — encoder + decoder only. The wiring layer (UI + QR
 * rendering + clipboard handoff) is left for the next pass.
 */

import { createHash } from "node:crypto";

export interface TrustInvitePayload {
  /** Machine to add to the trusted set. */
  machineId: string;
  /** Display name (shown in confirmation). */
  machineName: string;
  /** Expiry — unix millis. After this, the link is rejected. */
  expiresAtMs: number;
  /** HMAC-style signature over the body (caller decides secret). */
  signature: string;
}

export function signTrustInvite(
  body: Omit<TrustInvitePayload, "signature">,
  secret: string,
): string {
  const canonical = `${body.machineId}|${body.machineName}|${String(body.expiresAtMs)}`;
  return createHash("sha256").update(`${secret}:${canonical}`).digest("hex").slice(0, 32);
}

export function encodeTrustInvite(payload: TrustInvitePayload): string {
  const body = JSON.stringify(payload);
  return Buffer.from(body, "utf8").toString("base64url");
}

export type DecodeTrustInviteResult =
  | { ok: true; value: TrustInvitePayload }
  | { ok: false; reason: "malformed" | "expired" | "bad_signature" };

export function decodeTrustInvite(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): DecodeTrustInviteResult {
  let body: TrustInvitePayload;
  try {
    body = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as TrustInvitePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof body.machineId !== "string" ||
    typeof body.machineName !== "string" ||
    typeof body.expiresAtMs !== "number" ||
    typeof body.signature !== "string"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (body.expiresAtMs < nowMs) return { ok: false, reason: "expired" };
  const expectedSig = signTrustInvite(
    {
      machineId: body.machineId,
      machineName: body.machineName,
      expiresAtMs: body.expiresAtMs,
    },
    secret,
  );
  if (expectedSig !== body.signature) return { ok: false, reason: "bad_signature" };
  return { ok: true, value: body };
}
