/**
 * v2.20.1 — defensive probe for VS Code's built-in Settings Sync session.
 *
 * `vscode.authentication.getSession("vscode-settings-sync", scopes)` is a
 * non-public provider id. It is **not** part of the stable API contract and
 * may be missing or renamed across builds (Insiders, Cursor, OSS forks).
 * This module wraps the call so:
 *
 *   - Missing provider → `{ available: false, reason: "provider_missing" }`.
 *   - Rejected by user → `{ available: false, reason: "user_rejected" }`.
 *   - Throws unrecognised error → `{ available: false, reason: "unknown_error", detail }`.
 *   - Otherwise → `{ available: true, sessionId, accountLabel }`.
 *
 * The host extension uses this to display "Sync via Settings Sync" link in
 * the sync settings panel only when the surface is reachable. The split
 * planner from `core/settingsSyncIntegration.ts` decides *what* to sync
 * once availability is confirmed; this module decides *whether* it can.
 */
import type * as vscode from "vscode";

export type SettingsSyncProbeResult =
  | { available: true; sessionId: string; accountLabel: string }
  | {
      available: false;
      reason: "provider_missing" | "user_rejected" | "unknown_error";
      detail?: string;
    };

const PROVIDER_ID = "vscode-settings-sync";
const REQUIRED_SCOPES: readonly string[] = [];

export interface ProbeOptions {
  /** Force a sign-in prompt instead of silent. */
  readonly createIfNone?: boolean;
}

/**
 * Take an injectable `vscode.authentication`-shaped surface so unit tests
 * can verify the probe's branching without importing real VS Code.
 */
export interface AuthSurface {
  getSession: (
    providerId: string,
    scopes: readonly string[],
    options?: { createIfNone?: boolean; silent?: boolean },
  ) => Promise<vscode.AuthenticationSession | undefined>;
}

export async function probeSettingsSyncSession(
  auth: AuthSurface,
  opts: ProbeOptions = {},
): Promise<SettingsSyncProbeResult> {
  let session: vscode.AuthenticationSession | undefined;
  try {
    session = await auth.getSession(PROVIDER_ID, REQUIRED_SCOPES, {
      createIfNone: opts.createIfNone === true,
      silent: opts.createIfNone !== true,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (/no authentication provider|provider .* not found/i.test(detail)) {
      return { available: false, reason: "provider_missing", detail };
    }
    if (/user (cancelled|rejected|denied)/i.test(detail)) {
      return { available: false, reason: "user_rejected", detail };
    }
    return { available: false, reason: "unknown_error", detail };
  }
  if (session === undefined) {
    return {
      available: false,
      reason: opts.createIfNone === true ? "user_rejected" : "provider_missing",
    };
  }
  return { available: true, sessionId: session.id, accountLabel: session.account.label };
}
