/**
 * P2P payload framing — wraps a raw DataChannel message in an authenticated,
 * type-tagged envelope so the receiver can dispatch without trusting the
 * sender to be honest about the frame layout.
 *
 * Wire format (binary, little-endian):
 *
 *   [version: u8 = 1]
 *   [type:    u8]      one of P2P_FRAME_TYPE values
 *   [seq:     u32]     monotonic per-session sequence number
 *   [reserved:u16 = 0] room for flags without a v2 bump
 *   [aes-256-gcm encryptBuffer(payload)]    // includes its own iv + authTag
 *
 * The header (8 bytes) is NOT encrypted — it stays clear so the receiver can
 * route by type before paying for AES, and so the AAD-less encryptBuffer
 * format from `core/encryption.ts` can be reused as-is. Tampering with the
 * header still fails because the decoded body must round-trip through
 * decryptBuffer, which throws on a bad authTag.
 *
 * vscode-free; the wrapper around `RTCDataChannel` lives in the UI layer.
 */
import { encryptBuffer, decryptBuffer } from "./encryption.js";

export const P2P_FRAME_VERSION = 1;
export const P2P_FRAME_HEADER_BYTES = 8;

export const P2P_FRAME_TYPE = {
  file_chunk: 1,
  manifest: 2,
  ack: 3,
  bye: 4,
} as const;

export type P2PFrameTypeName = keyof typeof P2P_FRAME_TYPE;
type P2PFrameTypeCode = (typeof P2P_FRAME_TYPE)[P2PFrameTypeName];

const TYPE_BY_CODE: Record<number, P2PFrameTypeName> = Object.fromEntries(
  Object.entries(P2P_FRAME_TYPE).map(([k, v]) => [v, k]),
) as Record<number, P2PFrameTypeName>;

function isFrameTypeCode(code: number): code is P2PFrameTypeCode {
  return code in TYPE_BY_CODE;
}

export interface P2PFrameInput {
  type: P2PFrameTypeName;
  seq: number;
  payload: Buffer;
}

export type P2PFrameDecodeResult =
  | { ok: true; type: P2PFrameTypeName; seq: number; payload: Buffer }
  | { ok: false; reason: string };

/**
 * Build a wire-ready frame: [header(8)] + encryptBuffer(key, payload).
 * Throws on invalid input — caller is expected to validate seq itself.
 */
export function encodeP2PFrame(key: Buffer, input: P2PFrameInput): Buffer {
  if (key.length !== 32) {
    throw new Error("p2pCryptoEnvelope: key must be 32 bytes (AES-256)");
  }
  if (!Number.isInteger(input.seq) || input.seq < 0 || input.seq > 0xffff_ffff) {
    throw new Error("p2pCryptoEnvelope: seq must be a u32 (0..2^32-1)");
  }
  const typeCode = P2P_FRAME_TYPE[input.type];
  const header = Buffer.alloc(P2P_FRAME_HEADER_BYTES);
  header.writeUInt8(P2P_FRAME_VERSION, 0);
  header.writeUInt8(typeCode, 1);
  header.writeUInt32LE(input.seq, 2);
  header.writeUInt16LE(0, 6);
  const body = encryptBuffer(key, input.payload);
  return Buffer.concat([header, body]);
}

/**
 * Strict decoder. Returns `{ ok: false, reason }` for any malformed input
 * (short header, unknown version / type, AES authTag failure). NEVER throws
 * on bad data — this is the trust boundary.
 *
 * The optional `expectedSeq` lets the caller reject replays / out-of-order
 * frames without re-implementing the comparison.
 */
export function decodeP2PFrame(
  key: Buffer,
  blob: Buffer,
  expectedSeq?: number,
): P2PFrameDecodeResult {
  if (key.length !== 32) {
    return { ok: false, reason: "key must be 32 bytes (AES-256)" };
  }
  if (blob.length < P2P_FRAME_HEADER_BYTES) {
    return { ok: false, reason: "frame shorter than header" };
  }
  const version = blob.readUInt8(0);
  if (version !== P2P_FRAME_VERSION) {
    return { ok: false, reason: `unsupported version: ${String(version)}` };
  }
  const typeCode = blob.readUInt8(1);
  if (!isFrameTypeCode(typeCode)) {
    return { ok: false, reason: `unknown type code: ${String(typeCode)}` };
  }
  const seq = blob.readUInt32LE(2);
  if (expectedSeq !== undefined && seq !== expectedSeq) {
    return { ok: false, reason: `seq mismatch: got ${String(seq)}, want ${String(expectedSeq)}` };
  }
  const reserved = blob.readUInt16LE(6);
  if (reserved !== 0) {
    return { ok: false, reason: `reserved bits set: ${String(reserved)}` };
  }
  const body = blob.subarray(P2P_FRAME_HEADER_BYTES);
  let payload: Buffer;
  try {
    payload = decryptBuffer(key, body);
  } catch (e) {
    return { ok: false, reason: `decrypt failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return {
    ok: true,
    type: TYPE_BY_CODE[typeCode],
    seq,
    payload,
  };
}
