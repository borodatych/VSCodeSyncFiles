/**
 * Tunnel status-bar widget — wires the pure formatter
 * {@link formatTunnelStatusBar} to a `vscode.StatusBarItem` (v2.13.3).
 *
 * Strategy:
 *   - Render snapshot from `tunnelStatusRegistry.getTunnelStatus()` on every
 *     refresh tick.
 *   - Drive refresh via a 5 s `setInterval`. The dispatcher writes to the
 *     registry synchronously on each open/fallback/dispose, so eventual
 *     consistency (≤ 5 s latency) is fine for a status bar.
 *   - Severity → background color: warn = yellow, error = red, ok = none.
 *   - Hide entirely when no snapshot exists (Tunnel disabled / not started).
 *
 * The widget is registered late in `activate()` once the dispatcher is
 * available. Disposal removes both the StatusBarItem and the interval.
 */
import * as vscode from "vscode";
import { getTunnelStatus } from "../core/tunnelStatusRegistry.js";
import { formatTunnelStatusBar } from "../core/tunnelStatusBarFormatter.js";

const REFRESH_INTERVAL_MS = 5_000;

export interface TunnelStatusBarHandle extends vscode.Disposable {
  /** Force an immediate render — call from dispatcher events for snappier UX. */
  refresh: () => void;
}

export function createTunnelStatusBarItem(
  context: vscode.ExtensionContext,
): TunnelStatusBarHandle {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
  item.name = "VSCodeSync · Tunnel";

  const renderOnce = (): void => {
    const snapshot = getTunnelStatus();
    if (!snapshot) {
      item.hide();
      return;
    }
    const payload = formatTunnelStatusBar(snapshot);
    item.text = payload.text;
    const tooltip = new vscode.MarkdownString(payload.tooltip);
    tooltip.isTrusted = false;
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    item.command = payload.commandId;
    if (payload.severity === "error") {
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (payload.severity === "warn") {
      item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      item.backgroundColor = undefined;
    }
    item.show();
  };

  renderOnce();
  const handle = setInterval(renderOnce, REFRESH_INTERVAL_MS);

  const disposable: TunnelStatusBarHandle = {
    refresh: renderOnce,
    dispose(): void {
      clearInterval(handle);
      item.dispose();
    },
  };
  context.subscriptions.push(disposable);
  return disposable;
}
