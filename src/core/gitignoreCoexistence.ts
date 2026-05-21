/**
 * v0.13 F-054 — pure detector for the VSCodeSync .gitignore block.
 *
 * We insert a marker-delimited block into `.gitignore` so the
 * user can find and edit it. The block looks like:
 *
 *     # >>> VSCodeSync managed (do not edit between markers) >>>
 *     .vscode/vscodesync.json
 *     .vscode/vscodesync-local-backup/
 *     # <<< VSCodeSync managed <<<
 *
 * After rebase / cherry-pick the block can disappear from a working copy.
 * The watcher in the UI layer calls `detectMissingGitignoreEntries`; this
 * pure helper reads the current `.gitignore` content (or "" when missing)
 * and returns the diff: what we *would* add.
 */

export const GITIGNORE_BEGIN_MARKER = "# >>> VSCodeSync managed (do not edit between markers) >>>";
export const GITIGNORE_END_MARKER = "# <<< VSCodeSync managed <<<";

export const REQUIRED_GITIGNORE_ENTRIES: readonly string[] = [
  ".vscode/vscodesync.json",
  ".vscode/vscodesync-local-backup/",
  ".vscodesync-quicktransfer/",
];

export interface GitignoreCoexistenceReport {
  /** True when the managed block is present and contains all required entries. */
  blockPresent: boolean;
  /** Entries that need to be added (either block missing or entries missing inside). */
  missingEntries: string[];
  /** Recommended action: insert / repair / none. */
  recommendation: "insert" | "repair" | "none";
}

/** Inspect `.gitignore` content and report what's missing. Pure. */
export function detectMissingGitignoreEntries(
  gitignoreContent: string,
): GitignoreCoexistenceReport {
  const lines = gitignoreContent.split(/\r?\n/);
  const beginIdx = lines.findIndex((l) => l.trim() === GITIGNORE_BEGIN_MARKER);
  const endIdx = lines.findIndex((l) => l.trim() === GITIGNORE_END_MARKER);

  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    // Block missing entirely; check for ad-hoc entries (user may have manually
    // added some) — anything not in there is "missing".
    const presentEntries = new Set(lines.map((l) => l.trim()).filter((l) => l.length > 0));
    const missing = REQUIRED_GITIGNORE_ENTRIES.filter((e) => !presentEntries.has(e));
    return {
      blockPresent: false,
      missingEntries: missing,
      recommendation: missing.length > 0 ? "insert" : "none",
    };
  }

  const blockEntries = new Set(
    lines.slice(beginIdx + 1, endIdx).map((l) => l.trim()).filter((l) => l.length > 0),
  );
  const missing = REQUIRED_GITIGNORE_ENTRIES.filter((e) => !blockEntries.has(e));
  return {
    blockPresent: true,
    missingEntries: missing,
    recommendation: missing.length > 0 ? "repair" : "none",
  };
}

/** Build the canonical managed block text. Caller decides where to insert it. */
export function buildManagedBlock(): string {
  const body = REQUIRED_GITIGNORE_ENTRIES.join("\n");
  return `${GITIGNORE_BEGIN_MARKER}\n${body}\n${GITIGNORE_END_MARKER}\n`;
}

/** Produce a repaired `.gitignore` content with the block re-inserted at the end. */
export function ensureManagedBlock(gitignoreContent: string): string {
  const report = detectMissingGitignoreEntries(gitignoreContent);
  if (report.recommendation === "none") return gitignoreContent;

  if (!report.blockPresent) {
    const sep = gitignoreContent.length > 0 && !gitignoreContent.endsWith("\n") ? "\n" : "";
    return `${gitignoreContent}${sep}\n${buildManagedBlock()}`;
  }

  // Repair: rebuild the block in-place.
  const lines = gitignoreContent.split(/\r?\n/);
  const beginIdx = lines.findIndex((l) => l.trim() === GITIGNORE_BEGIN_MARKER);
  const endIdx = lines.findIndex((l) => l.trim() === GITIGNORE_END_MARKER);
  const blockLines = buildManagedBlock().split(/\r?\n/).filter((l) => l.length > 0);
  const next = [
    ...lines.slice(0, beginIdx),
    ...blockLines,
    ...lines.slice(endIdx + 1),
  ];
  return next.join("\n");
}
