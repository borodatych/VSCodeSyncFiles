/**
 * v0.17 N21 — per-workspace `.vscodesyncrc.json` overrides.
 *
 * Settings precedence (highest wins):
 *   1. `.vscodesyncrc.json` at workspace root  ← new
 *   2. VS Code workspace folder settings
 *   3. VS Code Global settings
 *   4. Extension defaults
 *
 * The rc file is committed to git so the whole team gets the same
 * sync policy without leaking personal credentials. Schema is a thin
 * subset of safe-to-share settings — secrets / tokens are deliberately
 * NOT readable from here.
 */

/** Only these settings can be overridden via `.vscodesyncrc.json`. */
export const RC_OVERRIDE_ALLOWLIST: ReadonlySet<string> = new Set([
  "autoSyncMode",
  "sync.concurrency",
  "sync.workspaceConcurrency",
  "verifyUploadHash",
  "historyVersions",
  "historyMode",
  "warnOnBinaryFiles",
  "compressUploads",
  "gitBranchAutoSync",
  "pushOnCommit",
  "syncOnOpen",
  "perGlobSchedule",
  "hints.enabled",
]);

export interface VscodesyncRc {
  /** Schema version of the rc file format. v1 is current. */
  schemaVersion: number;
  /** Setting key → override value. Only allowlisted keys honoured. */
  settings: Record<string, unknown>;
  /** Optional human-readable comment shown in diagnostics. */
  description?: string;
}

export const EMPTY_RC: VscodesyncRc = { schemaVersion: 1, settings: {} };

export type ParseRcError =
  | "json_failed"
  | "shape_invalid"
  | "unknown_schema";

export type ParseRcResult =
  | { ok: true; rc: VscodesyncRc; rejectedKeys: string[] }
  | { ok: false; error: ParseRcError };

/** Parse the rc file content. Filters out non-allowlisted keys. */
export function parseVscodesyncRc(raw: string): ParseRcResult {
  // Use `unknown` initially so the shape guards below aren't dead-code.
  // JSON.parse can legitimately return `null` / array / primitive even
  // though the consumer expects a plain object.
  let raw0: unknown;
  try {
    raw0 = JSON.parse(raw);
  } catch {
    return { ok: false, error: "json_failed" };
  }
  if (raw0 === null || typeof raw0 !== "object" || Array.isArray(raw0)) {
    return { ok: false, error: "shape_invalid" };
  }
  const parsed = raw0 as Record<string, unknown>;
  const schemaVersion = parsed.schemaVersion;
  if (typeof schemaVersion !== "number" || schemaVersion !== 1) {
    return { ok: false, error: "unknown_schema" };
  }
  const settings = parsed.settings;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    return { ok: false, error: "shape_invalid" };
  }
  const rejectedKeys: string[] = [];
  const filteredSettings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings as Record<string, unknown>)) {
    if (RC_OVERRIDE_ALLOWLIST.has(k)) {
      filteredSettings[k] = v;
    } else {
      rejectedKeys.push(k);
    }
  }
  const rc: VscodesyncRc = {
    schemaVersion,
    settings: filteredSettings,
  };
  if (typeof parsed.description === "string") {
    rc.description = parsed.description;
  }
  return { ok: true, rc, rejectedKeys };
}

/** Resolve a setting key with rc-override precedence. Pure. */
export function resolveSettingWithRc<T>(
  key: string,
  rc: VscodesyncRc | null,
  vscodeValue: T,
): T {
  if (rc === null) return vscodeValue;
  if (!RC_OVERRIDE_ALLOWLIST.has(key)) return vscodeValue;
  const v = rc.settings[key];
  if (v === undefined) return vscodeValue;
  return v as T;
}
