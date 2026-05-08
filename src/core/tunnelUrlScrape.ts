/**
 * v2.4.2/3 — pure URL-scrape helpers for the cloudflared / tailscale tunnel
 * backends. Extracted so the regex logic can be unit-tested without spawning
 * a real binary.
 *
 * cloudflared writes the public URL to stderr, e.g.:
 *
 *     2024-06-15T12:00:00Z INF +-------------------------------------------+
 *     2024-06-15T12:00:00Z INF |  https://abc-def-ghi.trycloudflare.com    |
 *     2024-06-15T12:00:00Z INF +-------------------------------------------+
 *
 * tailscale funnel status outputs lines like:
 *
 *     https://my-machine.tailnet-1234.ts.net/   tcp://127.0.0.1:8000
 *     # Funnel on, https://my-machine.tailnet-1234.ts.net (tcp:443)
 *
 * No `vscode` import. No spawn. Caller streams stderr/stdout into
 * `scrapeTunnelUrl(buffer, kind)` until it returns a URL or the watchdog
 * timeout fires.
 */

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9](?:[a-z0-9-]{0,253}[a-z0-9])?\.trycloudflare\.com/gi;
const TAILSCALE_TS_NET_RE = /https:\/\/[a-z0-9](?:[a-z0-9-]{0,253}[a-z0-9])?\.[a-z0-9-]+\.ts\.net/gi;

export type TunnelScrapeKind = "cloudflared" | "tailscale-funnel";

/** Try to extract the public URL from a chunk of the binary's output. The
 * caller appends each new chunk to its accumulated buffer, then calls this
 * helper; it returns the first match or null. */
export function scrapeTunnelUrl(buffer: string, kind: TunnelScrapeKind): string | null {
  const re = kind === "cloudflared" ? TRYCLOUDFLARE_RE : TAILSCALE_TS_NET_RE;
  // Reset lastIndex since these are global regexes reused across calls.
  re.lastIndex = 0;
  const m = re.exec(buffer);
  return m ? m[0] : null;
}

/** Validate that a candidate URL passes basic shape checks before we hand it
 * back to the dispatcher. Catches the case where the regex matched something
 * inside an error message rather than the actual tunnel URL. */
export function isValidTunnelUrl(url: string, kind: TunnelScrapeKind): boolean {
  if (!url.startsWith("https://")) return false;
  if (kind === "cloudflared") {
    return url.endsWith(".trycloudflare.com");
  }
  return url.endsWith(".ts.net") || url.endsWith(".ts.net/");
}
