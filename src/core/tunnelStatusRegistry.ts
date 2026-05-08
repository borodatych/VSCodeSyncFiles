/**
 * v2.4.5 — vscode-free state for the showTunnelStatus command.
 *
 * Tunnel dispatcher writes here on every relay open / failover / dispose;
 * the UI command reads + renders to OutputChannel.
 */
import type { TunnelProviderType } from "../ui/tunnelProviderRegistry.js";

export interface TunnelStatusSnapshot {
  /** Active backend after fallback resolution (e.g. "smee" if cloudflared
   * fell back). */
  effectiveProvider: TunnelProviderType;
  /** Backend the user requested via setting. */
  requestedProvider: TunnelProviderType;
  /** Public URL we are listening on. */
  publicUrl: string;
  /** Times the dispatcher had to re-open this relay since the extension
   * activated. */
  restartCount: number;
  /** ms timestamp of when the (current) relay went up. */
  startedAtMs: number;
  /** Last failover reason ("backend_X_unavailable: <detail>" / "bind_failed: <error>"
   * / undefined when none). */
  lastFallbackReason?: string;
}

let current: TunnelStatusSnapshot | undefined = undefined;

export function setTunnelStatus(snapshot: TunnelStatusSnapshot): void {
  current = snapshot;
}

export function clearTunnelStatus(): void {
  current = undefined;
}

export function getTunnelStatus(): TunnelStatusSnapshot | undefined {
  return current;
}

export function bumpTunnelRestartCount(): void {
  if (current) current = { ...current, restartCount: current.restartCount + 1 };
}

export function noteTunnelFallback(reason: string): void {
  if (current) current = { ...current, lastFallbackReason: reason };
}

/**
 * Render the snapshot as plain text suitable for an OutputChannel. Pure
 * function — accepts an optional `now` for tests so uptime is deterministic.
 */
export function formatTunnelStatusReport(
  snapshot: TunnelStatusSnapshot | undefined,
  now: number = Date.now(),
): string {
  if (!snapshot) return "Tunnel: not active";
  const uptimeSeconds = Math.max(0, Math.floor((now - snapshot.startedAtMs) / 1000));
  const lines = [
    `Tunnel: ${snapshot.effectiveProvider}`,
    `Public URL: ${snapshot.publicUrl}`,
    `Requested provider: ${snapshot.requestedProvider}`,
    `Uptime: ${formatUptime(uptimeSeconds)}`,
    `Restarts: ${String(snapshot.restartCount)}`,
  ];
  if (snapshot.lastFallbackReason !== undefined) {
    lines.push(`Last fallback: ${snapshot.lastFallbackReason}`);
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
