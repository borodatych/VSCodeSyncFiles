/**
 * v2.4.5 — pure formatter for the status-bar widget that surfaces the
 * active webhook tunnel. UI layer (extension.ts) calls this on every
 * `tunnelStatusRegistry` event and pipes the result into a
 * `vscode.StatusBarItem`.
 *
 * No `vscode` import. The icon strings use VS Code's `$(name)` codicon
 * syntax which both `StatusBarItem.text` and `MarkdownString` understand.
 */

import type { TunnelStatusSnapshot } from "./tunnelStatusRegistry.js";

export interface TunnelStatusBarItem {
  /** Full text (codicon + label) for `StatusBarItem.text`. */
  text: string;
  /** Tooltip rendered as `MarkdownString` when shown. */
  tooltip: string;
  /** When set, status-bar item should add the warning background. */
  severity: TunnelStatusBarSeverity;
  /** When clicked, run this command id. Falls back to `showTunnelStatus`. */
  commandId: string;
}

export type TunnelStatusBarSeverity = "ok" | "warn" | "error";

/** Render snapshot → status-bar payload. Returns a "tunnel inactive" stub
 * when snapshot is undefined so the widget can stay registered but quiet. */
export function formatTunnelStatusBar(
  snapshot: TunnelStatusSnapshot | undefined,
  options: { commandId?: string; now?: number } = {},
): TunnelStatusBarItem {
  const commandId = options.commandId ?? "vscodesync.showTunnelStatus";
  if (!snapshot) {
    return {
      text: "$(plug) Tunnel: off",
      tooltip: "VSCodeSync: webhook tunnel is not active.",
      severity: "ok",
      commandId,
    };
  }
  const fellBack =
    snapshot.requestedProvider !== snapshot.effectiveProvider ||
    snapshot.lastFallbackReason !== undefined;
  const severity: TunnelStatusBarSeverity = pickSeverity(snapshot, fellBack);
  const icon = pickIcon(severity);
  const text = `${icon} Tunnel: ${snapshot.effectiveProvider}`;
  const tooltip = renderTooltip(snapshot, options.now ?? Date.now());
  return { text, tooltip, severity, commandId };
}

function pickSeverity(
  snapshot: TunnelStatusSnapshot,
  fellBack: boolean,
): TunnelStatusBarSeverity {
  if (snapshot.restartCount >= 3) return "error";
  if (fellBack) return "warn";
  return "ok";
}

function pickIcon(severity: TunnelStatusBarSeverity): string {
  switch (severity) {
    case "error":
      return "$(error)";
    case "warn":
      return "$(warning)";
    case "ok":
      return "$(plug)";
  }
}

function renderTooltip(snapshot: TunnelStatusSnapshot, now: number): string {
  const uptimeS = Math.max(0, Math.floor((now - snapshot.startedAtMs) / 1000));
  const lines: string[] = [
    `**Public URL:** ${snapshot.publicUrl}`,
    `**Requested:** ${snapshot.requestedProvider}`,
    `**Active:** ${snapshot.effectiveProvider}`,
    `**Uptime:** ${formatUptime(uptimeS)}`,
    `**Restarts:** ${String(snapshot.restartCount)}`,
  ];
  if (snapshot.lastFallbackReason !== undefined) {
    lines.push(`**Last fallback:** ${snapshot.lastFallbackReason}`);
  }
  return lines.join("\n");
}

function formatUptime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${String(h)}h ${String(m)}m ${String(s)}s`;
  if (m > 0) return `${String(m)}m ${String(s)}s`;
  return `${String(s)}s`;
}
