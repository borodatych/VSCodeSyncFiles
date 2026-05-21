/**
 * v0.17 N18 — pure builder for one-shot workspace invite links.
 *
 * Format: `vscodesync://invite/<base64url-payload>` where payload is JSON
 *   {
 *     v: 1,
 *     wid: <workspaceId>,
 *     wn: <workspaceNote>,
 *     pt: "onedrive" | "gdrive" | "yandex" | "dropbox",
 *     iss: <ISO timestamp>,
 *     exp: <ISO expiry, optional>,
 *     pf?: <passphrase fingerprint for encrypted ws, optional>,
 *   }
 *
 * The link DOES NOT carry actual credentials or DEK — receiver still
 * needs to provider-auth. It's a "pre-filled onboarding" shortcut.
 *
 * Decoder validates shape + freshness; rejects expired / future-iss.
 */

import type { ProviderType } from "./types.js";

export interface WorkspaceInvite {
  workspaceId: string;
  workspaceNote: string;
  providerType: ProviderType;
  issuedAtIso: string;
  expiresAtIso?: string;
  /** Optional fingerprint (first 12 hex of SHA-256(passphrase)) so the
   *  receiver can verify "you're using the right encryption key" without
   *  carrying the key itself. */
  passphraseFingerprint?: string;
}

export interface InviteEncodeOptions {
  workspaceId: string;
  workspaceNote: string;
  providerType: ProviderType;
  /** TTL in hours; default 168 (7 days). 0 = no expiry. */
  ttlHours?: number;
  /** Optional SHA-256 prefix of the workspace passphrase (12 hex chars). */
  passphraseFingerprint?: string;
  /** ISO override for tests. */
  nowIso?: string;
}

export type DecodeInviteError =
  | "scheme_mismatch"
  | "host_mismatch"
  | "base64_failed"
  | "json_failed"
  | "shape_invalid"
  | "expired"
  | "issued_in_future";

export type DecodeInviteResult =
  | { ok: true; invite: WorkspaceInvite }
  | { ok: false; error: DecodeInviteError };

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Buffer {
  const padding = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + padding;
  return Buffer.from(b64, "base64");
}

export function encodeInviteLink(opts: InviteEncodeOptions): string {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const ttlH = opts.ttlHours ?? 168;
  const expiresAtIso = ttlH > 0
    ? new Date(Date.parse(nowIso) + ttlH * 3600_000).toISOString()
    : undefined;
  const payload: Record<string, unknown> = {
    v: 1,
    wid: opts.workspaceId,
    wn: opts.workspaceNote,
    pt: opts.providerType,
    iss: nowIso,
  };
  if (expiresAtIso !== undefined) payload.exp = expiresAtIso;
  if (opts.passphraseFingerprint !== undefined) payload.pf = opts.passphraseFingerprint;
  const json = JSON.stringify(payload);
  const encoded = base64UrlEncode(Buffer.from(json, "utf8"));
  return `vscodesync://invite/${encoded}`;
}

export function decodeInviteLink(
  link: string,
  nowIso?: string,
): DecodeInviteResult {
  if (!link.startsWith("vscodesync://invite/")) {
    return link.startsWith("vscodesync://")
      ? { ok: false, error: "host_mismatch" }
      : { ok: false, error: "scheme_mismatch" };
  }
  const body = link.slice("vscodesync://invite/".length);
  let bin: Buffer;
  try {
    bin = base64UrlDecode(body);
  } catch {
    return { ok: false, error: "base64_failed" };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bin.toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "json_failed" };
  }
  if (
    typeof parsed.wid !== "string" || parsed.wid.length === 0 ||
    typeof parsed.wn !== "string" ||
    typeof parsed.pt !== "string" ||
    typeof parsed.iss !== "string"
  ) {
    return { ok: false, error: "shape_invalid" };
  }
  const now = Date.parse(nowIso ?? new Date().toISOString());
  const iss = Date.parse(parsed.iss);
  // Allow up to 5 min clock skew on issued-in-future.
  if (Number.isFinite(iss) && iss - now > 5 * 60_000) {
    return { ok: false, error: "issued_in_future" };
  }
  if (typeof parsed.exp === "string") {
    const exp = Date.parse(parsed.exp);
    if (Number.isFinite(exp) && now > exp) {
      return { ok: false, error: "expired" };
    }
  }
  const invite: WorkspaceInvite = {
    workspaceId: parsed.wid,
    workspaceNote: parsed.wn,
    providerType: parsed.pt as ProviderType,
    issuedAtIso: parsed.iss,
    expiresAtIso: typeof parsed.exp === "string" ? parsed.exp : undefined,
    passphraseFingerprint: typeof parsed.pf === "string" ? parsed.pf : undefined,
  };
  return { ok: true, invite };
}
