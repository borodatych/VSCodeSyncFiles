/**
 * v2.4.3 — pure parser for `tailscale funnel status` stdout. Used in the
 * pre-flight check before the spawn watchdog actually starts the tunnel.
 *
 * Shapes the parser handles (across tailscale 1.50+):
 *
 *   1. Funnel ON, listening port:
 *
 *        # Funnel on:
 *        # - https://my-machine.tailnet-1234.ts.net (tcp:443)
 *        # https://my-machine.tailnet-1234.ts.net (tcp:443)
 *        https://my-machine.tailnet-1234.ts.net (tcp:443)
 *
 *   2. Funnel OFF (legitimate, but caller must show enable hint):
 *
 *        # Funnel is off
 *        Funnel is off
 *
 *   3. ACL forbids Funnel (most common failure mode users hit):
 *
 *        funnel is forbidden by tailnet policy ("funnel" not in ACL)
 *        you do not have access to use the Funnel feature
 *
 *   4. Not logged in / daemon not running:
 *
 *        not logged in. Run `tailscale up`
 *        failed to connect to local tailscaled
 *
 * No `vscode` import. No spawn — caller pipes stdout/stderr in.
 */

export type TailscaleFunnelAclResult =
  | { ok: true; enabled: true; listeningUrls: string[] }
  | { ok: true; enabled: false }
  | {
      ok: false;
      reason: TailscaleFunnelAclRejection;
      /** Truncated, sanitised version of the message — safe to show in toast. */
      hint: string;
    };

export type TailscaleFunnelAclRejection =
  | "acl_denied"
  | "not_logged_in"
  | "daemon_unavailable"
  | "unknown";

const TS_NET_URL_RE = /https:\/\/[a-z0-9](?:[a-z0-9-]{0,253}[a-z0-9])?\.[a-z0-9-]+\.ts\.net(?:\/[^\s)]*)?/gi;
const ACL_PATTERNS = [
  /forbidden by tailnet policy/i,
  /not in acl/i,
  /do not have access to use the funnel/i,
  /funnel is not enabled/i,
];
const NOT_LOGGED_IN_PATTERNS = [
  /not logged in/i,
  /tailscale up/i,
  /not authenticated/i,
];
const DAEMON_PATTERNS = [
  /failed to connect to local tailscaled/i,
  /could not connect to tailscaled/i,
  /is the tailscale daemon running/i,
];

/** Parse combined stdout/stderr of `tailscale funnel status` into a
 *  caller-actionable result. */
export function parseTailscaleFunnelStatus(text: string): TailscaleFunnelAclResult {
  if (text.length === 0) {
    return { ok: false, reason: "unknown", hint: "Empty output from tailscale funnel status." };
  }
  if (matchesAny(text, ACL_PATTERNS)) {
    return {
      ok: false,
      reason: "acl_denied",
      hint: "Tailscale Funnel is blocked by your tailnet ACL. Ask an admin to add `\"funnel\"` to the policy.",
    };
  }
  if (matchesAny(text, DAEMON_PATTERNS)) {
    return {
      ok: false,
      reason: "daemon_unavailable",
      hint: "Tailscale daemon is not running. Start it before enabling the tunnel provider.",
    };
  }
  if (matchesAny(text, NOT_LOGGED_IN_PATTERNS)) {
    return {
      ok: false,
      reason: "not_logged_in",
      hint: "You are not logged in to Tailscale. Run `tailscale up` first.",
    };
  }
  const urls = extractUrls(text);
  if (urls.length > 0) {
    return { ok: true, enabled: true, listeningUrls: urls };
  }
  if (/funnel is off/i.test(text) || /funnel.*disabled/i.test(text)) {
    return { ok: true, enabled: false };
  }
  return {
    ok: false,
    reason: "unknown",
    hint: "Unrecognised output from tailscale funnel status.",
  };
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  for (const re of patterns) {
    if (re.test(text)) return true;
  }
  return false;
}

function extractUrls(text: string): string[] {
  const out: string[] = [];
  // Match in a fresh regex instance because the global flag has lastIndex state.
  const re = new RegExp(TS_NET_URL_RE.source, "gi");
  for (const m of text.matchAll(re)) {
    const u = m[0];
    if (!out.includes(u)) out.push(u);
  }
  return out;
}
