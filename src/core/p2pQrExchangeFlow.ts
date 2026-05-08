/**
 * v2.1.2 — pure QR-exchange flow controller for the air-gapped pair.
 *
 * Layered on top of `p2pQrExchange.ts` primitives (`planQrChunks` /
 * `createQrAssembler`). The wizard step planner (`p2pSessionWizardSteps.ts`)
 * decides *whether* QR is the transport; this module drives the *internal*
 * sub-state of the actual QR loop:
 *
 *   inviter:  render_offer → await_answer_scan → decode_answer → done
 *   invitee:  await_offer_scan → render_answer → await_ack → done
 *
 * The controller exposes only pure inputs (next-chunk-line, tick, advance).
 * The UI layer renders the current chunk via `qrcode-terminal` and feeds
 * scanner lines back. No `vscode`, no IO.
 *
 * Errors during scan (bad_format / wrong_protocol / session_mismatch) are
 * surfaced as discriminated `{ ok:false, reason }` results — the UI may
 * show an inline toast and let the user re-scan the same chunk.
 */

import {
  createQrAssembler,
  planQrChunks,
  encodeQrChunkLine,
  type QrAssembler,
  type QrChunk,
} from "./p2pQrExchange.js";

export type QrExchangeRole = "inviter" | "invitee";

export type QrExchangePhase =
  | "render_offer"
  | "await_offer_scan"
  | "render_answer"
  | "await_answer_scan"
  | "decode_answer"
  | "await_ack"
  | "done";

export interface QrExchangeState {
  role: QrExchangeRole;
  phase: QrExchangePhase;
  /** Chunks the local party should display, in order. */
  outboundChunks: QrChunk[];
  /** Index into `outboundChunks` of the chunk currently shown. UI rotates
   *  when user clicks "Next QR". */
  outboundCursor: number;
  /** Number of inbound chunks scanned so far (for progress UI). */
  inboundScanned: number;
  /** Total chunks expected from the peer (known after the first valid scan). */
  inboundTotal: number | null;
  /** Decoded peer payload once the inbound assembler completes. */
  inboundPayload: string | null;
}

export interface QrExchangeFlow {
  readonly state: QrExchangeState;
  /** The line the UI should encode into a QR right now. `null` means
   *  there's nothing to render in the current phase. */
  currentOutboundLine(): string | null;
  /** Rotate to the next outbound chunk. Wraps at end so the user can
   *  re-show the first chunk if the peer missed it. Returns the new line. */
  nextOutboundChunk(): string | null;
  /** Feed a scanned line. Returns either advance info or a parser/wire
   *  error that the UI should surface. */
  acceptScannedLine(line: string): QrScanResult;
  /** Caller acknowledges the peer confirmed reception of all outbound
   *  chunks (out-of-band signal — e.g. user clicked "Done" once the peer's
   *  status flipped). Advances the phase. */
  acknowledgeOutboundDelivered(): void;
  /** Caller marks ICE exchange complete (after both sides decoded). */
  complete(): void;
}

export type QrScanResult =
  | { ok: true; phaseAdvanced: boolean; complete: boolean }
  | { ok: false; reason: QrScanRejection };

export type QrScanRejection =
  | "bad_format"
  | "wrong_protocol"
  | "bad_session"
  | "bad_index"
  | "session_mismatch"
  | "total_mismatch"
  | "wrong_phase";

export interface CreateQrExchangeFlowOptions {
  role: QrExchangeRole;
  /** Local party's signaling payload (offer for inviter, answer for invitee).
   *  Pre-encoded JSON string. */
  localPayload: string;
  /** Session id (8..32 chars [A-Za-z0-9_-]) — same on both sides. */
  sessionId: string;
  /** Override chunk size for tests / paranoid wire limits. */
  chunkLen?: number;
}

export function createQrExchangeFlow(opts: CreateQrExchangeFlowOptions): QrExchangeFlow {
  const outboundChunks = planQrChunks(opts.localPayload, opts.sessionId, opts.chunkLen);
  const inboundAssembler: QrAssembler = createQrAssembler();

  const initialPhase: QrExchangePhase =
    opts.role === "inviter" ? "render_offer" : "await_offer_scan";

  const internal: QrExchangeState = {
    role: opts.role,
    phase: initialPhase,
    outboundChunks,
    outboundCursor: 0,
    inboundScanned: 0,
    inboundTotal: null,
    inboundPayload: null,
  };

  const isOutboundPhase = (phase: QrExchangePhase): boolean =>
    phase === "render_offer" || phase === "render_answer";

  const isScanPhase = (phase: QrExchangePhase): boolean =>
    phase === "await_offer_scan" ||
    phase === "await_answer_scan" ||
    phase === "decode_answer";

  return {
    get state(): QrExchangeState {
      return internal;
    },
    currentOutboundLine(): string | null {
      if (!isOutboundPhase(internal.phase)) return null;
      // planQrChunks guarantees length >= 1; cursor is always in-range.
      return encodeQrChunkLine(internal.outboundChunks[internal.outboundCursor]);
    },
    nextOutboundChunk(): string | null {
      if (!isOutboundPhase(internal.phase)) return null;
      internal.outboundCursor = (internal.outboundCursor + 1) % internal.outboundChunks.length;
      return encodeQrChunkLine(internal.outboundChunks[internal.outboundCursor]);
    },
    acceptScannedLine(line): QrScanResult {
      if (!isScanPhase(internal.phase)) {
        return { ok: false, reason: "wrong_phase" };
      }
      const r = inboundAssembler.pushChunk(line);
      if (!r.ok) return { ok: false, reason: r.reason as QrScanRejection };
      internal.inboundScanned += 1;
      // After the first valid scan the assembler knows the total.
      if (internal.inboundTotal === null) {
        const parts = line.split("|");
        const total = parts.length === 5 ? Number(parts[3]) : null;
        if (total !== null && Number.isInteger(total) && total > 0) {
          internal.inboundTotal = total;
        }
      }
      if (!r.complete) {
        return { ok: true, phaseAdvanced: false, complete: false };
      }
      // Inbound assembler done — decode peer payload.
      internal.inboundPayload = inboundAssembler.finalize();
      const advanced = advancePhaseAfterScanComplete(internal);
      return { ok: true, phaseAdvanced: advanced, complete: internal.phase === "done" };
    },
    acknowledgeOutboundDelivered(): void {
      if (internal.phase === "render_offer") {
        internal.phase = "await_answer_scan";
        return;
      }
      if (internal.phase === "render_answer") {
        internal.phase = "await_ack";
      }
    },
    complete(): void {
      internal.phase = "done";
    },
  };
}

function advancePhaseAfterScanComplete(state: QrExchangeState): boolean {
  // invitee just scanned the offer → render their answer.
  if (state.role === "invitee" && state.phase === "await_offer_scan") {
    state.phase = "render_answer";
    return true;
  }
  // inviter just scanned the answer → ICE handoff, ready for `complete()`.
  if (state.role === "inviter" && state.phase === "await_answer_scan") {
    state.phase = "decode_answer";
    return true;
  }
  if (state.phase === "decode_answer") {
    state.phase = "done";
    return true;
  }
  return false;
}
