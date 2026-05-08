/**
 * v2.1.3 — pure formatter for the status-bar widget that surfaces an active
 * P2P session. UI layer subscribes to `P2PSessionState` transitions and pipes
 * the result into a `vscode.StatusBarItem`.
 *
 * No `vscode` import. The icon strings use VS Code's `$(name)` codicon syntax
 * which both `StatusBarItem.text` and `MarkdownString` understand.
 */

import type { P2PSessionState } from "./p2pSessionStateMachine.js";

export type P2PStatusBarSeverity = "ok" | "warn" | "error" | "off";

export interface P2PStatusBarItem {
  /** Full text (codicon + label) for `StatusBarItem.text`. */
  text: string;
  /** Tooltip rendered as `MarkdownString` when shown. */
  tooltip: string;
  /** Caller may colour the bar background based on this. */
  severity: P2PStatusBarSeverity;
  /** Click handler command id. */
  commandId: string;
}

export interface P2PStatusBarSnapshot {
  state: P2PSessionState;
  /** "cloud" via manifest channel or "qr" for air-gapped pair. */
  transport: "cloud" | "qr";
  /** Number of remote peers currently bound to this session. Usually 0 or 1. */
  peerCount: number;
  /** Session label rendered in tooltip — caller-supplied (machine name etc.). */
  peerLabel?: string;
}

/** Render a snapshot to the widget payload. Returns an off-state stub when
 *  the state machine is `idle` so the bar can stay registered but quiet. */
export function formatP2PStatusBar(
  snapshot: P2PStatusBarSnapshot | undefined,
  options: { commandId?: string; now?: number } = {},
): P2PStatusBarItem {
  const commandId = options.commandId ?? "vscodesync.showP2PSessionStatus";
  if (snapshot === undefined || snapshot.state.kind === "idle") {
    return {
      text: "$(broadcast) P2P: off",
      tooltip: "VSCodeSync: no P2P session is active.",
      severity: "off",
      commandId,
    };
  }
  const severity = pickSeverity(snapshot.state);
  const icon = pickIcon(severity);
  const label = pickLabel(snapshot);
  const text = `${icon} P2P: ${label}`;
  const tooltip = renderTooltip(snapshot, options.now ?? Date.now());
  return { text, tooltip, severity, commandId };
}

function pickSeverity(state: P2PSessionState): P2PStatusBarSeverity {
  switch (state.kind) {
    case "connected":
      return "ok";
    case "connecting":
    case "reconnecting":
      return "warn";
    case "disconnected":
      return "error";
    case "idle":
      return "off";
  }
}

function pickIcon(severity: P2PStatusBarSeverity): string {
  switch (severity) {
    case "ok":
      return "$(broadcast)";
    case "warn":
      return "$(sync~spin)";
    case "error":
      return "$(error)";
    case "off":
      return "$(broadcast)";
  }
}

function pickLabel(snapshot: P2PStatusBarSnapshot): string {
  switch (snapshot.state.kind) {
    case "connected":
      return `${String(snapshot.peerCount)} peer${snapshot.peerCount === 1 ? "" : "s"} (alpha)`;
    case "connecting":
      return "connecting…";
    case "reconnecting":
      return `reconnecting (#${String(snapshot.state.attempt)})`;
    case "disconnected":
      return "disconnected";
    case "idle":
      return "off";
  }
}

function renderTooltip(snapshot: P2PStatusBarSnapshot, now: number): string {
  const lines: string[] = [];
  const transportLabel = snapshot.transport === "cloud" ? "cloud signaling" : "QR signaling";
  lines.push(`**Transport:** ${transportLabel}`);
  if (snapshot.peerLabel !== undefined && snapshot.peerLabel !== "") {
    lines.push(`**Peer:** ${snapshot.peerLabel}`);
  }
  lines.push(`**Peers:** ${String(snapshot.peerCount)}`);
  lines.push(`**State:** ${snapshot.state.kind}`);
  switch (snapshot.state.kind) {
    case "connected": {
      const sessionS = Math.max(0, Math.floor((now - snapshot.state.sinceMs) / 1000));
      const heartbeatAgoS = Math.max(
        0,
        Math.floor((now - snapshot.state.lastHeartbeatAtMs) / 1000),
      );
      lines.push(`**Uptime:** ${formatDuration(sessionS)}`);
      lines.push(`**Last heartbeat:** ${formatDuration(heartbeatAgoS)} ago`);
      break;
    }
    case "connecting": {
      const sinceS = Math.max(0, Math.floor((now - snapshot.state.sinceMs) / 1000));
      lines.push(`**Connecting for:** ${formatDuration(sinceS)}`);
      break;
    }
    case "reconnecting": {
      lines.push(`**Attempt:** ${String(snapshot.state.attempt)}`);
      lines.push(`**Next retry in:** ${formatDuration(Math.floor(snapshot.state.nextDelayMs / 1000))}`);
      break;
    }
    case "disconnected": {
      lines.push(`**Reason:** ${snapshot.state.reason}`);
      break;
    }
    case "idle": {
      break;
    }
  }
  return lines.join("\n");
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${String(h)}h ${String(m)}m ${String(s)}s`;
  if (m > 0) return `${String(m)}m ${String(s)}s`;
  return `${String(s)}s`;
}
