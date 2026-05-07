/**
 * Pure presence-status classifier for the Workspaces tree's per-machine
 * indicator. Maps `lastSeen` ISO-8601 → one of three buckets:
 *
 *   - `online`   ≤ 5 minutes — Discord-style "online" green dot
 *   - `recent`   ≤ 24 hours — yellow dot
 *   - `offline`  longer / unknown — gray dot
 *
 * vscode-free: tested in isolation. `TreeItem.iconPath` mapping is the
 * caller's job (different ThemeColor per status).
 */

export type MachinePresence = "online" | "recent" | "offline";

export const ONLINE_WINDOW_MS = 5 * 60_000;
export const RECENT_WINDOW_MS = 24 * 3600_000;

export function classifyPresence(
  lastSeenIso: string | undefined,
  now: number = Date.now(),
): MachinePresence {
  if (!lastSeenIso) return "offline";
  const t = Date.parse(lastSeenIso);
  if (Number.isNaN(t)) return "offline";
  const diff = now - t;
  if (diff < 0) return "online"; // clock skew — be optimistic
  if (diff <= ONLINE_WINDOW_MS) return "online";
  if (diff <= RECENT_WINDOW_MS) return "recent";
  return "offline";
}

/** Human-readable label for hover tooltips. */
export function describePresence(
  lastSeenIso: string | undefined,
  now: number = Date.now(),
): string {
  if (!lastSeenIso) return "offline (no record)";
  const t = Date.parse(lastSeenIso);
  if (Number.isNaN(t)) return "offline (invalid timestamp)";
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return "online (just now)";
  if (diff < 3600_000) return `online (${String(Math.floor(diff / 60_000))}m ago)`;
  if (diff < 86_400_000) return `recent (${String(Math.floor(diff / 3600_000))}h ago)`;
  const days = Math.floor(diff / 86_400_000);
  return `offline (${String(days)}d ago)`;
}
