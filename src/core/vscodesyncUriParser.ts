/**
 * v0.10 F-022 — pure parser for the `vscodesync://` URI scheme.
 *
 * Supported shapes:
 *   vscodesync://workspace/<wid>                  → focus workspace tree node
 *   vscodesync://workspace/<wid>/<rel/path>       → open tracked file (attach if needed)
 *   vscodesync://command/<cmdId>                  → execute a whitelisted command
 *
 * Decisions:
 *   - Path segments are percent-decoded; nested slashes preserved through encodeURIComponent.
 *   - `wid` validation: alphanumeric + `-`/`_`, length 4–64.
 *   - Command id validation: must start with `vscodesync.`, length ≤ 80, only `A-Za-z0-9._-`.
 *
 * No `vscode` import — UI layer takes the parse result and routes.
 */

export type VscodeSyncAction =
  | { kind: "openWorkspace"; workspaceId: string }
  | { kind: "openFile"; workspaceId: string; posixRel: string }
  | { kind: "runCommand"; commandId: string };

export type VscodeSyncParseError =
  | "scheme_mismatch"
  | "host_unknown"
  | "missing_workspace_id"
  | "invalid_workspace_id"
  | "invalid_command_id"
  | "command_not_whitelisted"
  | "empty";

export type VscodeSyncParseResult =
  | { ok: true; action: VscodeSyncAction }
  | { ok: false; error: VscodeSyncParseError };

const WID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const CMD_RE = /^vscodesync\.[A-Za-z0-9._-]{1,80}$/;

/**
 * Hard whitelist of commands that may be invoked via URI. This is the
 * surface a malicious crafted link could touch, so keep it minimal —
 * read-only / observational only. Destructive ops (delete, repair,
 * take-ownership) deliberately excluded.
 */
// v0.17 A4 — whitelist entries must match actually-registered command IDs.
// Verified against `package.json#contributes.commands` 2026-05-21.
export const URI_COMMAND_WHITELIST: ReadonlySet<string> = new Set([
  "vscodesync.focusWorkspacesView",
  "vscodesync.showSyncSummary",
  "vscodesync.openActivityFeed",
  "vscodesync.profileSync",
  "vscodesync.cycleAutoSyncMode",
  "vscodesync.explainFileSyncState",
  "vscodesync.exportSupportBundle",
]);

/** Parse a string URI. Returns a discriminated result without throwing. */
export function parseVscodeSyncUri(raw: string): VscodeSyncParseResult {
  if (!raw || typeof raw !== "string") return { ok: false, error: "empty" };
  // Use the WHATWG URL parser. Custom schemes have `host` for the first
  // segment (`vscodesync://workspace/...` → host="workspace").
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "scheme_mismatch" };
  }
  if (url.protocol !== "vscodesync:") return { ok: false, error: "scheme_mismatch" };

  const host = url.host;
  const segments = url.pathname.split("/").filter((s) => s.length > 0).map((s) => safeDecode(s));

  if (host === "workspace") {
    const wid = segments[0];
    if (!wid) return { ok: false, error: "missing_workspace_id" };
    if (!WID_RE.test(wid)) return { ok: false, error: "invalid_workspace_id" };
    if (segments.length === 1) {
      return { ok: true, action: { kind: "openWorkspace", workspaceId: wid } };
    }
    const posixRel = segments.slice(1).join("/");
    return { ok: true, action: { kind: "openFile", workspaceId: wid, posixRel } };
  }
  if (host === "command") {
    const cmdId = segments[0];
    if (!cmdId) return { ok: false, error: "invalid_command_id" };
    if (!CMD_RE.test(cmdId)) return { ok: false, error: "invalid_command_id" };
    if (!URI_COMMAND_WHITELIST.has(cmdId)) return { ok: false, error: "command_not_whitelisted" };
    return { ok: true, action: { kind: "runCommand", commandId: cmdId } };
  }
  return { ok: false, error: "host_unknown" };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Build a `vscodesync://` URI for a workspace (+ optional file). Pure. */
export function buildVscodeSyncUri(action: VscodeSyncAction): string {
  switch (action.kind) {
    case "openWorkspace":
      return `vscodesync://workspace/${encodeURIComponent(action.workspaceId)}`;
    case "openFile": {
      const segments = action.posixRel.split("/").map(encodeURIComponent).join("/");
      return `vscodesync://workspace/${encodeURIComponent(action.workspaceId)}/${segments}`;
    }
    case "runCommand":
      return `vscodesync://command/${encodeURIComponent(action.commandId)}`;
  }
}
