/**
 * v0.16 N08 — `.syncexclude` store: UI-managed sibling of `.syncignore`.
 *
 * `.syncignore` is a flat gitignore-style pattern file the user edits in
 * a text editor. `.syncexclude` is the same shape, but populated by the
 * right-click "Exclude from sync" action — additions are pure single-line
 * appends, removals are pure regex-anchored line drops. This module is
 * the pure read/write surface; UI provides the file.
 *
 * Format: posix-relative paths, one per line, leading `#` for comments.
 * Trailing slash means "directory recursion".
 */

export interface SyncExcludeFile {
  /** Lines preserved in original order (comments + entries). */
  lines: string[];
  /** Active entries (de-commented, trimmed, non-empty). */
  entries: string[];
}

const COMMENT_RE = /^\s*#/;

export function parseSyncExcludeFile(raw: string): SyncExcludeFile {
  const lines = raw.split(/\r?\n/);
  const entries: string[] = [];
  for (const raw_line of lines) {
    const line = raw_line.trim();
    if (line.length === 0) continue;
    if (COMMENT_RE.test(line)) continue;
    entries.push(line);
  }
  return { lines, entries };
}

export function isExcluded(file: SyncExcludeFile, posixRel: string): boolean {
  for (const entry of file.entries) {
    if (entry === posixRel) return true;
    // Directory recursion: entry ends with `/` and posixRel is under it.
    if (entry.endsWith("/") && posixRel.startsWith(entry)) return true;
  }
  return false;
}

/** Add an exclusion. Idempotent. Preserves comments. Returns new file content. */
export function addExclusion(
  file: SyncExcludeFile,
  posixRel: string,
): string {
  if (file.entries.includes(posixRel)) {
    return file.lines.join("\n");
  }
  const next = [...file.lines];
  if (next.length > 0 && next[next.length - 1] !== "") {
    next.push("");
  }
  next.push(posixRel);
  next.push("");
  return next.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Remove an exclusion. Pure.
 *  v0.17 A12 — collapse blank-line runs >2 so multiple round trips don't
 *  accumulate empty lines from addExclusion's padding. */
export function removeExclusion(
  file: SyncExcludeFile,
  posixRel: string,
): string {
  return file.lines
    .filter((line) => line.trim() !== posixRel)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Build a fresh empty file with a header comment. */
export function emptySyncExcludeFile(): string {
  return [
    "# VSCodeSync · UI-managed exclusion list",
    "# Lines added here via right-click \"Exclude from sync\" — edit by hand if you want.",
    "# Posix-rel paths; trailing slash = directory recursion.",
    "",
  ].join("\n");
}
