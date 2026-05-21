/**
 * v0.13 F-055 — pure detector for the kind of folder VS Code opened.
 *
 * Inputs:
 *   - `folderPath` — absolute filesystem path of the workspace folder
 *   - `siblings` — flat list of file/dir names at the same level (caller does
 *     the readdir) — used to spot `.git`, `.devcontainer/`, etc.
 *   - `gitHeadContent` — `.git/HEAD` content when present (string)
 *   - `worktreeListContent` — output of `git worktree list --porcelain` when
 *     available (optional)
 *
 * Output classifies the folder as `normal | worktree | devcontainer | submodule`
 * and reports useful hints (parent repo, dev container image name, etc.).
 *
 * No `fs` / `vscode` imports here.
 */

export type WorkspaceContextKind = "normal" | "worktree" | "devcontainer" | "submodule";

export interface WorkspaceContext {
  kind: WorkspaceContextKind;
  /** Parent repo absolute path for `worktree`/`submodule`. */
  parentRepoPath?: string;
  /** Devcontainer image name when extractable from the JSON sniff. */
  devcontainerImage?: string;
  /** Worktree branch name (from gitdir-rev. */
  worktreeBranch?: string;
}

export interface DetectWorkspaceContextInput {
  folderPath: string;
  siblings: readonly string[];
  /** `.git/HEAD` content if `.git` is a file (worktree) or directory. */
  gitHeadContent?: string;
  /** When `.git` is a file ("gitdir: ..."), the resolved gitdir absolute path. */
  resolvedGitDir?: string;
  /** First 4 KB of `.devcontainer/devcontainer.json` if present. */
  devcontainerSnippet?: string;
}

const DEVCONTAINER_IMAGE_RE = /"image"\s*:\s*"([^"]+)"/;
const HEAD_REF_BRANCH_RE = /^ref:\s+refs\/heads\/(.+)$/;

/** True when `name` appears in the flat sibling list. The caller is
 *  responsible for distinguishing files from directories — this is just
 *  presence-check (a directory may be `.devcontainer`, a file `.gitignore`). */
function siblingExists(name: string, siblings: readonly string[]): boolean {
  return siblings.includes(name);
}

export function detectWorkspaceContext(input: DetectWorkspaceContextInput): WorkspaceContext {
  // 1) Devcontainer wins early — the user is in a containerised env.
  if (siblingExists(".devcontainer", input.siblings) || input.devcontainerSnippet !== undefined) {
    const m = input.devcontainerSnippet ? DEVCONTAINER_IMAGE_RE.exec(input.devcontainerSnippet) : null;
    return {
      kind: "devcontainer",
      devcontainerImage: m?.[1],
    };
  }
  // 2) Worktree — `.git` is a regular file (containing `gitdir: ...`), not a dir.
  if (input.resolvedGitDir?.includes("/worktrees/")) {
    const parentRepoPath = extractParentRepoFromWorktreeGitDir(input.resolvedGitDir);
    const branch = extractBranchFromHead(input.gitHeadContent);
    return {
      kind: "worktree",
      parentRepoPath,
      worktreeBranch: branch,
    };
  }
  // 3) Submodule — `.git` is a file, but `resolvedGitDir` points into the
  //    PARENT repo's modules dir (no /worktrees/ segment).
  if (input.resolvedGitDir?.includes("/modules/")) {
    // Drop `/.git/modules/...` → return the bare repo root.
    const parentRoot = input.resolvedGitDir.split("/.git/modules/")[0];
    return {
      kind: "submodule",
      parentRepoPath: parentRoot,
    };
  }
  return { kind: "normal" };
}

/** Extract the bare parent-repo path from a worktree's gitdir line.
 *  Example: `/home/u/project/.git/worktrees/feat-x` → `/home/u/project`. */
function extractParentRepoFromWorktreeGitDir(gitDir: string): string | undefined {
  const idx = gitDir.indexOf("/.git/worktrees/");
  if (idx === -1) return undefined;
  return gitDir.slice(0, idx);
}

function extractBranchFromHead(head: string | undefined): string | undefined {
  if (head === undefined) return undefined;
  const trimmed = head.trim();
  const m = HEAD_REF_BRANCH_RE.exec(trimmed);
  return m?.[1];
}
