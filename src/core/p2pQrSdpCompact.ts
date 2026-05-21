/**
 * v0.11 F-030 — pure compact SDP encoder for QR-based P2P signaling.
 *
 * WebRTC SDP is ~2-4 KB; QR codes max out around 2.9 KB at L-error-correction
 * but practical phone-cameras need ≤ 1.5 KB for reliable scan. This module
 *  - strips known-noise lines (`a=ice-options`, comment lines, etc),
 *  - gzip-compresses the result,
 *  - base64url-encodes,
 *  - prepends a fixed header `vsync1.` for sanity-check.
 *
 * Decoder is the inverse. Both round-trip in pure JS — `zlib` is from
 * `node:zlib` (desktop) and falls back to the WHATWG `CompressionStream` on
 * the web. The caller provides a `gzipSync`/`gunzipSync` pair.
 *
 * No `vscode` import.
 */

import { gzipSync, gunzipSync } from "node:zlib";

export interface QrSdpEnvelope {
  payload: string;
  /** Approximate UTF-8 bytes — for the UI to warn before printing the QR. */
  byteSize: number;
}

const HEADER = "vsync1.";

/** Tight whitespace + dedup of repeated lines that webrtc tolerates. */
function minifySdp(sdp: string): string {
  // We only need to track fingerprint lines for dedup — Chromium's
  // RTCPeerConnection sometimes emits the same `a=fingerprint:` twice
  // (once per media section). Other line kinds may legitimately repeat
  // (multiple `a=candidate:` lines is normal).
  const fingerprintSeen = new Set<string>();
  const keep: string[] = [];
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("a=ice-options:")) continue;
    if (line.startsWith("a=msid-semantic:")) continue;
    if (line.startsWith("a=fingerprint:")) {
      if (fingerprintSeen.has(line)) continue;
      fingerprintSeen.add(line);
    }
    keep.push(line);
  }
  return keep.join("\n");
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(s: string): Buffer {
  const padding = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + padding;
  return Buffer.from(b64, "base64");
}

/** Encode a full SDP into the compact payload string. */
export function encodeQrSdpEnvelope(sdp: string): QrSdpEnvelope {
  const minified = minifySdp(sdp);
  const gz = gzipSync(Buffer.from(minified, "utf8"), { level: 9 });
  const payload = HEADER + base64UrlEncode(gz);
  return { payload, byteSize: Buffer.byteLength(payload, "utf8") };
}

export type DecodeError =
  | "missing_header"
  | "base64_decode_failed"
  | "gunzip_failed";

export type DecodeResult =
  | { ok: true; sdp: string }
  | { ok: false; error: DecodeError };

/** Decode a `vsync1.` payload back into SDP. */
export function decodeQrSdpEnvelope(payload: string): DecodeResult {
  if (!payload.startsWith(HEADER)) return { ok: false, error: "missing_header" };
  const body = payload.slice(HEADER.length);
  let bin: Buffer;
  try {
    bin = base64UrlDecode(body);
  } catch {
    return { ok: false, error: "base64_decode_failed" };
  }
  try {
    const raw = gunzipSync(bin).toString("utf8");
    return { ok: true, sdp: raw };
  } catch {
    return { ok: false, error: "gunzip_failed" };
  }
}

/**
 * Helper for the UI: estimate whether the payload fits in a single QR code
 * at typical error correction levels. WebRTC SDP after gzip is usually
 * 500–1500 bytes; we warn above 1800 to leave room for QR overhead.
 */
export function isQrFriendlySize(byteSize: number): boolean {
  return byteSize <= 1800;
}
