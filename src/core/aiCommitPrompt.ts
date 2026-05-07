/**
 * Pure prompt-builder for AI commit-message suggestions. vscode-free so the
 * prompt shape can be unit-tested directly. The LM call lives in
 * `aiCommitMessage.ts` (which depends on `vscode`).
 */

export const MAX_FILES = 30;
export const MAX_PATH_LEN = 80;

export interface CommitContext {
  /** Workspace name (helps the model anchor on intent). */
  workspaceNote: string;
  /** Recently changed files in this workspace; truncated for token-budget. */
  changedFiles: readonly string[];
  /** Optional intent override — "snapshot" vs "transfer" tweaks tone. */
  intent?: "snapshot" | "transfer";
}

export function truncatePath(p: string, max: number = MAX_PATH_LEN): string {
  if (p.length <= max) return p;
  return `…${p.slice(-(max - 1))}`;
}

export function buildCommitPrompt(ctx: CommitContext): string {
  const intent = ctx.intent ?? "snapshot";
  const trimmedFiles = ctx.changedFiles.slice(0, MAX_FILES).map((p) => truncatePath(p));
  const intentLabel =
    intent === "snapshot"
      ? "snapshot of a workspace before further work"
      : "one-shot file transfer to another machine";
  return `You are summarising a developer's intent for a ${intentLabel}.

Workspace: ${ctx.workspaceNote || "(unnamed)"}

Files involved (max ${String(MAX_FILES)}, sorted):
${trimmedFiles.map((p) => `- ${p}`).join("\n")}

Output ONE line in Conventional-Commit form: "type: short summary".
Pick a single type from: feat, fix, chore, refactor, test, docs, perf, ci.
Use lowercase summary (≤ 60 chars), no trailing dot. Output only that line —
no preamble, no explanation. If the file list is too vague, output:
chore: workspace snapshot`;
}
