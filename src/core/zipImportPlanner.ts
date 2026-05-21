/**
 * v0.16 N03 — pure planner for "import workspace from .zip / .tar".
 *
 * Caller hands in:
 *   - list of paths inside the archive (`entries[]`)
 *   - optional workspaceNote hint (from archive name)
 * Output:
 *   - posix-relative paths sanitised (no `..`, no absolute)
 *   - suggested workspaceNote (cleaned)
 *   - skipped entries (with reason)
 *   - rough size estimate
 *
 * Caller wires the actual extraction.
 */

export interface ZipEntry {
  path: string;
  bytes?: number;
  isDirectory?: boolean;
}

export interface ZipImportPlan {
  workspaceNote: string;
  files: { posixRel: string; bytes?: number }[];
  skipped: { path: string; reason: string }[];
  totalBytes: number;
}

const SUSPECT_PATH_RE = /(^|\/)(\.\.)(\/|$)/;
// v0.17 A13 — block Windows-drive-letter prefixes (e.g. "C:/foo"). After
// stripping a leading `/`, such entries would resolve as absolute on
// Windows when `path.join`'d to the workspace root, leaking outside.
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

function sanitiseRel(raw: string): string | null {
  let path = raw.replace(/\\/g, "/");
  if (path.startsWith("/")) path = path.slice(1);
  if (path.length === 0) return null;
  if (SUSPECT_PATH_RE.test(path)) return null;
  if (WINDOWS_DRIVE_RE.test(path)) return null;
  return path;
}

export function planZipImport(
  entries: readonly ZipEntry[],
  hint: string,
): ZipImportPlan {
  const workspaceNote = hint
    .replace(/\.(zip|tar|tar\.gz|tgz)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .slice(0, 80) || "Imported workspace";

  const files: { posixRel: string; bytes?: number }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let total = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const safe = sanitiseRel(entry.path);
    if (!safe) {
      skipped.push({ path: entry.path, reason: "unsafe-path (../ or absolute)" });
      continue;
    }
    // Drop OS noise.
    if (safe.endsWith(".DS_Store") || safe.endsWith("Thumbs.db")) {
      skipped.push({ path: entry.path, reason: "os-noise" });
      continue;
    }
    // Drop existing VSCodeSync metadata (it'll be regenerated).
    if (safe === ".vscode/vscodesync.json") {
      skipped.push({ path: entry.path, reason: "vscodesync-meta-regenerated" });
      continue;
    }
    files.push({ posixRel: safe, bytes: entry.bytes });
    total += entry.bytes ?? 0;
  }

  return { workspaceNote, files, skipped, totalBytes: total };
}
