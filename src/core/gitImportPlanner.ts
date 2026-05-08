/**
 * v3.E — pure planner: parse a `.gitignore` content and translate to
 * `.vscodesync-ignore` patterns.
 *
 * The two formats differ only slightly: VSCodeSync uses a strict
 * gitignore-subset (no negation, no `!`). We:
 *   - Drop comment / blank lines.
 *   - Drop negation (`!pattern`) lines and report them as warnings (caller
 *     shows a "couldn't import N negation rules" toast).
 *   - Strip leading `/` (gitignore allows root-anchor; we treat all patterns
 *     as workspace-relative).
 *   - Pass the rest through.
 *
 * No `vscode` import.
 */

export interface GitImportPlanResult {
  /** Patterns ready to write into `.vscodesync-ignore`. */
  patterns: string[];
  /** Negation lines (gitignore `!pattern`) that we cannot import — caller
   * surfaces these in the import wizard. */
  unsupportedNegations: string[];
  /** Comments preserved (as-is, with leading `#`). For optional inclusion. */
  comments: string[];
}

export function planGitImport(gitignoreContent: string): GitImportPlanResult {
  const patterns: string[] = [];
  const unsupportedNegations: string[] = [];
  const comments: string[] = [];

  for (const rawLine of gitignoreContent.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, ""); // trailing whitespace
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      comments.push(line);
      continue;
    }
    if (line.startsWith("!")) {
      unsupportedNegations.push(line);
      continue;
    }
    // Strip root-anchor / and unescape \# / \!.
    let p = line.replace(/^\/+/, "");
    p = p.replace(/^\\([!#])/, "$1");
    if (p.length > 0) patterns.push(p);
  }

  return { patterns, unsupportedNegations, comments };
}

/** Render the planned import as a writable `.vscodesync-ignore` file body
 * (preserves comments, drops negations). */
export function renderVscodesyncIgnore(plan: GitImportPlanResult): string {
  const lines: string[] = [];
  lines.push("# Imported from .gitignore via vscodesync.initFromGit");
  if (plan.unsupportedNegations.length > 0) {
    lines.push(
      `# ${String(plan.unsupportedNegations.length)} negation rule(s) skipped — VSCodeSync .vscodesync-ignore does not support !`,
    );
  }
  for (const c of plan.comments) lines.push(c);
  for (const p of plan.patterns) lines.push(p);
  return `${lines.join("\n")}\n`;
}
