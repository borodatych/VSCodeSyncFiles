/**
 * P2P session status-bar widget — wires {@link formatP2PStatusBar} to a
 * `vscode.StatusBarItem` via the {@link P2PSessionRegistry} (v2.12.2).
 *
 * The widget is registered once on activate(); it stays hidden until at least
 * one session is in flight (`connecting` / `connected` / `reconnecting`),
 * matching the off-state contract of the formatter. Click runs
 * `vscodesync.disconnectP2PSession` so users have a one-step exit.
 *
 * No setInterval — re-renders are driven by `registry.subscribe()`. That
 * tracks the registry's notify-on-mutation contract; status latency is the
 * mutation latency, not a poll interval.
 */
import * as vscode from "vscode";
import {
  formatP2PStatusBar,
  type P2PStatusBarSeverity,
} from "../core/p2pStatusBarFormatter.js";
import type { P2PSessionRegistry } from "../core/p2pSessionRegistry.js";

const DISCONNECT_COMMAND = "vscodesync.disconnectP2PSession";

export interface P2PStatusBarHandle extends vscode.Disposable {
  refresh: () => void;
}

export function createP2PStatusBarItem(
  context: vscode.ExtensionContext,
  registry: P2PSessionRegistry,
): P2PStatusBarHandle {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 94);
  item.name = "VSCodeSync · P2P";

  const renderOnce = (): void => {
    const primary = registry.primary();
    const payload = formatP2PStatusBar(primary?.snapshot, { commandId: DISCONNECT_COMMAND });
    item.text = payload.text;
    const tooltip = new vscode.MarkdownString(payload.tooltip);
    tooltip.isTrusted = false;
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    item.command = payload.commandId;
    item.backgroundColor = backgroundFor(payload.severity);
    if (payload.severity === "off") {
      item.hide();
    } else {
      item.show();
    }
  };

  renderOnce();
  const unsubscribe = registry.subscribe(() => { renderOnce(); });

  const handle: P2PStatusBarHandle = {
    refresh: renderOnce,
    dispose(): void {
      unsubscribe();
      item.dispose();
    },
  };
  context.subscriptions.push(handle);
  return handle;
}

function backgroundFor(severity: P2PStatusBarSeverity): vscode.ThemeColor | undefined {
  switch (severity) {
    case "error":
      return new vscode.ThemeColor("statusBarItem.errorBackground");
    case "warn":
      return new vscode.ThemeColor("statusBarItem.warningBackground");
    case "ok":
    case "off":
    default:
      return undefined;
  }
}
