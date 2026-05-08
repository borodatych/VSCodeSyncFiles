/**
 * v2.4.5 — `vscodesync.showTunnelStatus` command.
 *
 * Reads the current snapshot from `tunnelStatusRegistry` (vscode-free) and
 * renders it into the dedicated OutputChannel.
 */
import * as vscode from "vscode";
import {
  formatTunnelStatusReport,
  getTunnelStatus,
} from "../core/tunnelStatusRegistry.js";

export function registerTunnelStatusCommand(): vscode.Disposable[] {
  const channel = vscode.window.createOutputChannel("VSCodeSync · Tunnel");
  return [
    channel,
    vscode.commands.registerCommand("vscodesync.showTunnelStatus", () => {
      const snapshot = getTunnelStatus();
      channel.clear();
      channel.appendLine(formatTunnelStatusReport(snapshot));
      channel.show(true);
    }),
  ];
}
