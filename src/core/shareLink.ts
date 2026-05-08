/**
 * v3.K — pure helpers to generate and parse VSCode-deep-link share URLs.
 *
 *   vscode://borodatych.vscodesyncfiles/share?workspace=<id>&snapshot=<name>
 *     [&exp=<isoTs>]
 *     [&pwd=<sha256-hex>]
 *
 * The `pwd` field is a *hash* of the password — it's a quick-check token, not a
 * cryptographic ACL. Cloud-side ACL is the actual access enforcement.
 */
const SHARE_LINK_BASE = "vscode://borodatych.vscodesyncfiles/share";
const WORKSPACE_RE = /^[A-Za-z0-9_-]{4,64}$/;
const SNAPSHOT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PWD_HASH_RE = /^[0-9a-f]{64}$/;

export interface ShareLinkInput {
  workspaceId: string;
  snapshotName: string;
  /** ms-since-epoch expiry. */
  expiresAtMs?: number;
  /** SHA-256 hex of the share password (callers compute via existing
   * hash helper). */
  passwordHashHex?: string;
}

export type ShareLinkParseResult =
  | { ok: true; payload: ShareLinkInput }
  | { ok: false; reason: "bad_url" | "wrong_path" | "missing_field" | "bad_field" | "expired" };

export function buildShareLink(input: ShareLinkInput): string {
  if (!WORKSPACE_RE.test(input.workspaceId)) {
    throw new Error(`shareLink: invalid workspaceId "${input.workspaceId}"`);
  }
  if (!SNAPSHOT_RE.test(input.snapshotName)) {
    throw new Error(`shareLink: invalid snapshotName "${input.snapshotName}"`);
  }
  if (input.passwordHashHex !== undefined && !PWD_HASH_RE.test(input.passwordHashHex)) {
    throw new Error("shareLink: passwordHashHex must be lowercase 64-char hex");
  }
  const params = new URLSearchParams();
  params.set("workspace", input.workspaceId);
  params.set("snapshot", input.snapshotName);
  if (input.expiresAtMs !== undefined) {
    params.set("exp", new Date(input.expiresAtMs).toISOString());
  }
  if (input.passwordHashHex !== undefined) {
    params.set("pwd", input.passwordHashHex);
  }
  return `${SHARE_LINK_BASE}?${params.toString()}`;
}

export function parseShareLink(raw: string, now: number = Date.now()): ShareLinkParseResult {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  // protocol+host+path comparison
  const got = `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, "");
  const want = SHARE_LINK_BASE.replace(/\/$/, "");
  if (got !== want) return { ok: false, reason: "wrong_path" };

  const workspaceId = u.searchParams.get("workspace");
  const snapshotName = u.searchParams.get("snapshot");
  if (!workspaceId || !snapshotName) return { ok: false, reason: "missing_field" };
  if (!WORKSPACE_RE.test(workspaceId)) return { ok: false, reason: "bad_field" };
  if (!SNAPSHOT_RE.test(snapshotName)) return { ok: false, reason: "bad_field" };

  const expRaw = u.searchParams.get("exp");
  let expiresAtMs: number | undefined;
  if (expRaw !== null) {
    const t = Date.parse(expRaw);
    if (Number.isNaN(t)) return { ok: false, reason: "bad_field" };
    expiresAtMs = t;
    if (now > t) return { ok: false, reason: "expired" };
  }

  const pwd = u.searchParams.get("pwd");
  let passwordHashHex: string | undefined;
  if (pwd !== null) {
    if (!PWD_HASH_RE.test(pwd)) return { ok: false, reason: "bad_field" };
    passwordHashHex = pwd;
  }

  const payload: ShareLinkInput = { workspaceId, snapshotName };
  if (expiresAtMs !== undefined) payload.expiresAtMs = expiresAtMs;
  if (passwordHashHex !== undefined) payload.passwordHashHex = passwordHashHex;
  return { ok: true, payload };
}
