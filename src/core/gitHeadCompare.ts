/**
 * v3.L — pure helpers for the workspace-level git history compare.
 *
 * Caller reads `.git/HEAD` from disk and `_meta.json.gitBranch` from the
 * cloud manifest — this module:
 *   - parses `.git/HEAD` content into a branch name (or detached SHA).
 *   - compares local vs cloud and returns a verdict the UI can render.
 *
 * No `vscode` import.
 */

export type GitHeadInfo =
  | { kind: "branch"; branch: string }
  | { kind: "detached"; sha: string }
  | { kind: "unparseable" };

const HEAD_REF_RE = /^ref:\s+refs\/heads\/(.+)$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Parse the textual content of `.git/HEAD`. */
export function parseGitHead(content: string): GitHeadInfo {
  const trimmed = content.trim();
  if (trimmed.length === 0) return { kind: "unparseable" };
  const refMatch = HEAD_REF_RE.exec(trimmed);
  if (refMatch) return { kind: "branch", branch: refMatch[1] };
  if (SHA_RE.test(trimmed.toLowerCase())) return { kind: "detached", sha: trimmed.toLowerCase() };
  return { kind: "unparseable" };
}

export type GitBranchCompareVerdict =
  | { kind: "match"; branch: string }
  | { kind: "diverged"; localBranch: string; cloudBranch: string }
  | { kind: "local_detached"; localSha: string; cloudBranch: string }
  | { kind: "cloud_unset"; localBranch: string }
  | { kind: "local_unparseable" };

/** Compare local HEAD info with the cloud-side `_meta.json.gitBranch`. */
export function compareGitBranches(
  localHead: GitHeadInfo,
  cloudBranch: string | undefined,
): GitBranchCompareVerdict {
  if (localHead.kind === "unparseable") return { kind: "local_unparseable" };
  if (localHead.kind === "detached") {
    if (cloudBranch === undefined || cloudBranch.length === 0) {
      return { kind: "local_detached", localSha: localHead.sha, cloudBranch: "" };
    }
    return { kind: "local_detached", localSha: localHead.sha, cloudBranch };
  }
  // localHead.kind === "branch"
  if (cloudBranch === undefined || cloudBranch.length === 0) {
    return { kind: "cloud_unset", localBranch: localHead.branch };
  }
  if (cloudBranch === localHead.branch) {
    return { kind: "match", branch: localHead.branch };
  }
  return { kind: "diverged", localBranch: localHead.branch, cloudBranch };
}

/** Human-readable summary suitable for a toast. */
export function describeBranchVerdict(verdict: GitBranchCompareVerdict): string {
  switch (verdict.kind) {
    case "match":
      return `Branch matches: ${verdict.branch}`;
    case "diverged":
      return `Local branch '${verdict.localBranch}' differs from cloud '${verdict.cloudBranch}'`;
    case "local_detached":
      return `Local HEAD is detached at ${verdict.localSha.slice(0, 7)}; cloud is on '${verdict.cloudBranch}'`;
    case "cloud_unset":
      return `Cloud manifest has no gitBranch; local is on '${verdict.localBranch}'`;
    case "local_unparseable":
      return `Could not parse local .git/HEAD`;
  }
}
