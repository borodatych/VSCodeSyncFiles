/**
 * Where an inbound P2P file is allowed to land (B15).
 *
 * Deliveries used to be written straight into the workspace tree, so a peer
 * decided both the content and the moment. They now go to a staging folder and
 * wait for the user; this module owns the two path decisions that guards that,
 * with no filesystem access so both can be tested directly.
 */
import * as path from "node:path";

/** Staging root, relative to the workspace root. */
export const P2P_STAGING_DIR = path.join(".vscode", "vscodesync-incoming");

export type P2PStagingPlan =
  | { ok: true; stagingAbs: string; targetAbs: string; relPath: string }
  | { ok: false; reason: "empty" | "absolute" | "escapes_root" };

/**
 * Resolve a manifest's `relPath` against a workspace root.
 *
 * The check is deliberately duplicated from the frame decoder: a network peer
 * names this path, and the last thing between it and `fs.writeFile` should not
 * be a decoder that some future manifest source might bypass.
 */
export function planP2PStaging(
  workspaceRoot: string,
  relPathRaw: string,
  transferId: string,
): P2PStagingPlan {
  const rel = relPathRaw.trim().replace(/\\/g, "/");
  if (rel === "") {
    return { ok: false, reason: "empty" };
  }
  if (path.posix.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    return { ok: false, reason: "absolute" };
  }
  const root = path.resolve(workspaceRoot);
  const targetAbs = path.resolve(root, rel);
  if (!targetAbs.startsWith(root + path.sep)) {
    return { ok: false, reason: "escapes_root" };
  }
  const segments = rel.split("/").filter((s) => s !== "" && s !== ".");
  const stagingAbs = path.join(root, P2P_STAGING_DIR, sanitizeTransferId(transferId), ...segments);
  return { ok: true, stagingAbs, targetAbs, relPath: segments.join("/") };
}

/** `transferId` is peer-supplied too and becomes a directory name here. */
function sanitizeTransferId(transferId: string): string {
  const cleaned = transferId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return cleaned === "" ? "unknown" : cleaned;
}
