/** Best-effort: VS Code / Electron exposes `navigator.onLine`. Assume online if unknown. */
export function readPassiveOnlineHint(): boolean {
  const nav =
    "navigator" in globalThis
      ? (globalThis as { navigator?: { onLine?: boolean } }).navigator
      : undefined;
  if (!nav) return true;
  return nav.onLine !== false;
}
