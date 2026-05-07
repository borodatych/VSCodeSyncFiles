/** Best-effort: VS Code / Electron exposes `navigator.onLine`. Assume online if unknown. */
export function readPassiveOnlineHint(): boolean {
  const nav =
    typeof globalThis !== "undefined" && "navigator" in globalThis
      ? (globalThis as { navigator?: { onLine?: boolean } }).navigator
      : undefined;
  if (nav === undefined || nav === null) {
    return true;
  }
  return nav.onLine !== false;
}
