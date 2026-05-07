/**
 * Best-effort metered flag — Chromium exposes NetworkInformation.metered where supported.
 * Returns null when unknown (caller must not treat as metered).
 */
export function readNavigatorMetered(): boolean | null {
  try {
    const nav = (globalThis as unknown as { navigator?: { connection?: { metered?: boolean } } }).navigator;
    const m = nav?.connection?.metered;
    return typeof m === "boolean" ? m : null;
  } catch {
    return null;
  }
}
