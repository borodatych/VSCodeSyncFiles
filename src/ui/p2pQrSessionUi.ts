/**
 * v2.1.2 / v2.12.1 — QR exchange UI flow.
 *
 * Wires the pure helpers from
 *   - `src/core/p2pQrExchangeFlow.ts:createQrExchangeFlow`
 *   - `src/core/p2pQrTerminalRenderer.ts:renderChunkBlock`
 * into a VS Code OutputChannel + InputBox loop:
 *
 *   inviter: render offer chunks one at a time → ask for scanned answer
 *            via InputBox until the assembler reports `complete: true`.
 *   invitee: ask for scanned offer chunks via InputBox until complete →
 *            render answer chunks → wait for ack.
 *
 * Network DataChannel setup (the third step of QR-mode P2P) is out of
 * scope here — once both sides have decoded the peer payload, the caller
 * hands them to `openP2PSession` (or its QR variant once wired).
 *
 * The UI surfaces every error path the pure controller emits
 * (`bad_format` / `wrong_protocol` / `bad_session` / etc) as a non-blocking
 * info-message and keeps the InputBox open so the user can retry.
 */
import * as vscode from "vscode";
import {
  createQrExchangeFlow,
  type CreateQrExchangeFlowOptions,
  type QrExchangeFlow,
  type QrScanRejection,
} from "../core/p2pQrExchangeFlow.js";
import { renderChunkBlock } from "../core/p2pQrTerminalRenderer.js";

export interface RunQrSessionUiOptions extends CreateQrExchangeFlowOptions {
  /** Optional channel to reuse — caller owns disposal. When omitted the UI
   *  creates+disposes its own. */
  readonly outputChannel?: vscode.OutputChannel;
}

export type QrSessionUiResult =
  | { ok: true; peerPayload: string }
  | { ok: false; reason: "user_cancelled" | "renderer_unavailable" | "no_peer_payload"; detail?: string };

const CHANNEL_NAME = "VSCodeSync · P2P QR";

export async function runQrSessionUi(
  options: RunQrSessionUiOptions,
): Promise<QrSessionUiResult> {
  const flow = createQrExchangeFlow(options);
  const channel = options.outputChannel ?? vscode.window.createOutputChannel(CHANNEL_NAME);
  const ownsChannel = options.outputChannel === undefined;

  try {
    return await drive(flow, channel, options.role);
  } finally {
    if (ownsChannel) channel.dispose();
  }
}

async function drive(
  flow: QrExchangeFlow,
  channel: vscode.OutputChannel,
  role: "inviter" | "invitee",
): Promise<QrSessionUiResult> {
  channel.show(true);
  channel.appendLine(`VSCodeSync · P2P QR session (${role})`);
  channel.appendLine("");

  for (let safety = 0; safety < 200; safety += 1) {
    const phase = flow.state.phase;
    if (phase === "done") {
      const peer = flow.state.inboundPayload;
      if (peer === null) return { ok: false, reason: "no_peer_payload" };
      return { ok: true, peerPayload: peer };
    }
    if (phase === "render_offer" || phase === "render_answer") {
      const stop = await renderOutboundPhase(flow, channel);
      if (stop !== null) return stop;
      continue;
    }
    if (phase === "await_offer_scan" || phase === "await_answer_scan" || phase === "decode_answer") {
      const stop = await scanInboundPhase(flow, channel);
      if (stop !== null) return stop;
      continue;
    }
    // The remaining phase is `await_ack`.
    const choice = await vscode.window.showInformationMessage(
      "VSCodeSync · QR: дождитесь подтверждения от другой машины и нажмите OK.",
      { modal: true },
      "OK",
      "Отмена",
    );
    if (choice !== "OK") return { ok: false, reason: "user_cancelled" };
    flow.complete();
  }
  return { ok: false, reason: "user_cancelled", detail: "loop safety guard tripped" };
}

async function renderOutboundPhase(
  flow: QrExchangeFlow,
  channel: vscode.OutputChannel,
): Promise<QrSessionUiResult | null> {
  let line = flow.currentOutboundLine();
  if (line === null) {
    flow.acknowledgeOutboundDelivered();
    return null;
  }
  const total = flow.state.outboundChunks.length;
  for (;;) {
    channel.appendLine(`Покажите этот QR другой машине (${String(flow.state.outboundCursor + 1)}/${String(total)}):`);
    const block = renderChunkBlock(
      {
        chunkIndex: flow.state.outboundCursor,
        totalChunks: total,
        sessionId: chunkSessionId(line),
        chunkLine: line,
      },
      { small: true },
    );
    if (!block.ok) {
      return {
        ok: false,
        reason: "renderer_unavailable",
        detail: `qrcode-terminal: ${block.reason}${block.error ? ` (${block.error})` : ""}`,
      };
    }
    for (const l of block.lines) channel.appendLine(l);
    channel.appendLine("");
    const next = await vscode.window.showInformationMessage(
      `VSCodeSync · QR: показан фрагмент ${String(flow.state.outboundCursor + 1)} из ${String(total)}.`,
      "Следующий",
      "Готово",
      "Отмена",
    );
    if (next === "Отмена" || next === undefined) {
      return { ok: false, reason: "user_cancelled" };
    }
    if (next === "Готово") {
      flow.acknowledgeOutboundDelivered();
      return null;
    }
    line = flow.nextOutboundChunk();
    if (line === null) {
      flow.acknowledgeOutboundDelivered();
      return null;
    }
  }
}

async function scanInboundPhase(
  flow: QrExchangeFlow,
  channel: vscode.OutputChannel,
): Promise<QrSessionUiResult | null> {
  while (
    flow.state.phase === "await_offer_scan" ||
    flow.state.phase === "await_answer_scan" ||
    flow.state.phase === "decode_answer"
  ) {
    const total = flow.state.inboundTotal;
    const scanned = flow.state.inboundScanned;
    const placeholder =
      total === null
        ? "Введите содержимое первого отсканированного QR (формат VSS1|...)."
        : `Отсканировано ${String(scanned)}/${String(total)}. Введите следующий QR.`;
    const input = await vscode.window.showInputBox({
      prompt: "VSCodeSync · QR: вставьте содержимое отсканированного QR",
      placeHolder: placeholder,
      ignoreFocusOut: true,
    });
    if (input === undefined) return { ok: false, reason: "user_cancelled" };
    if (input.trim().length === 0) continue;
    const r = flow.acceptScannedLine(input.trim());
    if (!r.ok) {
      channel.appendLine(`scan rejected: ${r.reason}`);
      await vscode.window.showWarningMessage(`VSCodeSync · QR: ${rejectionMessage(r.reason)}`);
      continue;
    }
    if (r.complete) {
      channel.appendLine("Сборка peer payload завершена.");
      return null;
    }
  }
  return null;
}

function chunkSessionId(line: string): string {
  // Wire format `VSS1|<sid>|<idx>|<total>|<base64>`.
  const parts = line.split("|");
  return parts.length >= 2 ? parts[1] ?? "?" : "?";
}

function rejectionMessage(reason: QrScanRejection): string {
  switch (reason) {
    case "bad_format": return "Неверный формат — ожидался VSS1|sid|idx|total|base64.";
    case "wrong_protocol": return "Чужой протокол. Ожидается VSS1.";
    case "bad_session": return "Session id повреждён или пуст.";
    case "bad_index": return "Невалидный chunk index.";
    case "session_mismatch": return "Session id не совпадает с локальным.";
    case "total_mismatch": return "Несовпадение количества chunk'ов в QR.";
    case "wrong_phase": return "Сейчас не время сканировать — попробуйте после смены фазы.";
  }
}
