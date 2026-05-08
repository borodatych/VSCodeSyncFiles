/**
 * v2.1.2 — pure helpers for QR-based offer/answer exchange.
 *
 * SDP offer/answer payloads can be larger than a single QR (≥ 30L cap is
 * 2 KB). We therefore split the payload into ordered chunks and
 * accompany each chunk with a small header so the scanner can:
 *   - reject chunks from a different session.
 *   - reorder out-of-order scans.
 *   - know when the set is complete.
 *
 * Wire format (per QR):
 *
 *   VSS1|<sessionId>|<idx>|<total>|<base64-payload-segment>
 *
 *   - sessionId : 8..32 chars [A-Za-z0-9_-]
 *   - idx, total : 1..N
 *   - payload-segment : base64 of one slice of the original offer/answer JSON.
 *
 * Caller renders each chunk to an actual QR via the npm `qrcode-terminal`
 * (ASCII) or any other QR library — this module is pure.
 *
 * The reassembler uses `pushChunk(line)` and reports `complete: true` once
 * all `total` chunks are present.
 *
 * No `vscode` import.
 */

const PROTOCOL_TAG = "VSS1";
const SESSION_RE = /^[A-Za-z0-9_-]{8,32}$/;
/** Each chunk's payload-segment is ≤ this many base64 chars; the framing
 * adds ≤ ~30 chars on top. Keeps the resulting QR safely under 2 KB. */
export const QR_CHUNK_PAYLOAD_BASE64_LIMIT = 1500;

export interface QrChunk {
  sessionId: string;
  idx: number;
  total: number;
  payloadB64Segment: string;
}

export function encodeQrChunkLine(chunk: QrChunk): string {
  return `${PROTOCOL_TAG}|${chunk.sessionId}|${String(chunk.idx)}|${String(chunk.total)}|${chunk.payloadB64Segment}`;
}

export type QrChunkParseResult =
  | { ok: true; chunk: QrChunk }
  | { ok: false; reason: "bad_format" | "wrong_protocol" | "bad_session" | "bad_index" };

export function parseQrChunkLine(line: string): QrChunkParseResult {
  const parts = line.split("|");
  if (parts.length !== 5) return { ok: false, reason: "bad_format" };
  const [tag, sessionId, idxStr, totalStr, payload] = parts;
  if (tag !== PROTOCOL_TAG) return { ok: false, reason: "wrong_protocol" };
  if (!SESSION_RE.test(sessionId)) return { ok: false, reason: "bad_session" };
  const idx = Number(idxStr);
  const total = Number(totalStr);
  if (
    !Number.isInteger(idx) ||
    !Number.isInteger(total) ||
    idx < 1 ||
    total < 1 ||
    idx > total
  ) {
    return { ok: false, reason: "bad_index" };
  }
  return { ok: true, chunk: { sessionId, idx, total, payloadB64Segment: payload } };
}

/** Split an arbitrary string payload into N QR chunks. The caller decides
 * what to put in `payload` (typically `JSON.stringify(P2POffer)`); we
 * base64-encode it and slice into ≤ `QR_CHUNK_PAYLOAD_BASE64_LIMIT` parts.
 *
 * Throws on invalid sessionId. */
export function planQrChunks(payload: string, sessionId: string, chunkLen: number = QR_CHUNK_PAYLOAD_BASE64_LIMIT): QrChunk[] {
  if (!SESSION_RE.test(sessionId)) {
    throw new Error(`p2pQrExchange: invalid sessionId "${sessionId}"`);
  }
  if (chunkLen < 64 || chunkLen > 8192) {
    throw new Error("p2pQrExchange: chunkLen out of range");
  }
  const b64 = Buffer.from(payload, "utf8").toString("base64");
  const total = Math.max(1, Math.ceil(b64.length / chunkLen));
  const chunks: QrChunk[] = [];
  for (let i = 0; i < total; i++) {
    chunks.push({
      sessionId,
      idx: i + 1,
      total,
      payloadB64Segment: b64.slice(i * chunkLen, (i + 1) * chunkLen),
    });
  }
  return chunks;
}

export interface QrAssembler {
  pushChunk(line: string): { ok: true; complete: boolean } | { ok: false; reason: string };
  isComplete(): boolean;
  /** Reassemble the original payload (utf-8 string). Throws if not complete. */
  finalize(): string;
}

export function createQrAssembler(): QrAssembler {
  let sessionId: string | null = null;
  let total: number | null = null;
  const chunks: (string | undefined)[] = [];

  return {
    pushChunk(line): { ok: true; complete: boolean } | { ok: false; reason: string } {
      const r = parseQrChunkLine(line);
      if (!r.ok) return { ok: false, reason: r.reason };
      if (sessionId === null) {
        sessionId = r.chunk.sessionId;
        total = r.chunk.total;
        for (let i = 0; i < total; i++) chunks.push(undefined);
      } else {
        if (sessionId !== r.chunk.sessionId) return { ok: false, reason: "session_mismatch" };
        if (total !== r.chunk.total) return { ok: false, reason: "total_mismatch" };
      }
      chunks[r.chunk.idx - 1] = r.chunk.payloadB64Segment;
      return { ok: true, complete: chunks.every((c) => c !== undefined) };
    },
    isComplete(): boolean {
      return chunks.length > 0 && chunks.every((c) => c !== undefined);
    },
    finalize(): string {
      if (!chunks.every((c) => c !== undefined)) throw new Error("qrAssembler: incomplete");
      const b64 = chunks.join("");
      return Buffer.from(b64, "base64").toString("utf8");
    },
  };
}
