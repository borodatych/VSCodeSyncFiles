/**
 * v3.E — pure step planner for the `vscodesync init from-git <repo-url>`
 * flow. Caller (CLI / VS Code command) walks the steps in order; this
 * module just answers "given URL X, what do I do?".
 *
 * Steps are intentionally fine-grained so the UI can show progress and
 * resume cleanly after failure.
 *
 * No `vscode` import. No actual `git clone` here — the caller spawns it
 * with the parsed URL.
 */

export type GitImportStepKind =
  | "validate_url"
  | "ensure_target_folder"
  | "git_clone"
  | "read_gitignore"
  | "translate_to_vscodesync_ignore"
  | "scan_files"
  | "create_workspace"
  | "add_files";

export interface GitImportStep {
  kind: GitImportStepKind;
  /** Human-readable progress label for the UI. */
  label: string;
  /** Caller payload — varies by kind. */
  payload?: Record<string, unknown>;
}

export interface ParsedRepoUrl {
  /** Original URL as supplied by the user. */
  raw: string;
  /** Host (github.com, gitlab.com, ...). */
  host: string;
  /** Owner / org. */
  owner: string;
  /** Repository name (without `.git`). */
  repo: string;
  /** Default folder name = `repo`. */
  suggestedFolderName: string;
}

const HTTPS_REPO_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const SSH_REPO_RE = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

export type ParseRepoUrlResult =
  | { ok: true; parsed: ParsedRepoUrl }
  | { ok: false; reason: "empty" | "unsupported_scheme" | "missing_owner_or_repo" };

export function parseRepoUrl(raw: string): ParseRepoUrlResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  const httpsMatch = HTTPS_REPO_RE.exec(trimmed);
  if (httpsMatch) {
    const [, host, owner, repo] = httpsMatch;
    if (!owner || !repo) return { ok: false, reason: "missing_owner_or_repo" };
    return {
      ok: true,
      parsed: { raw: trimmed, host, owner, repo, suggestedFolderName: repo },
    };
  }
  const sshMatch = SSH_REPO_RE.exec(trimmed);
  if (sshMatch) {
    const [, host, owner, repo] = sshMatch;
    if (!owner || !repo) return { ok: false, reason: "missing_owner_or_repo" };
    return {
      ok: true,
      parsed: { raw: trimmed, host, owner, repo, suggestedFolderName: repo },
    };
  }
  return { ok: false, reason: "unsupported_scheme" };
}

export interface PlanImportInputs {
  /** Raw URL the user supplied. */
  url: string;
  /** Absolute folder where the repo will be cloned. */
  targetFolderAbs: string;
}

export type PlanImportResult =
  | { ok: true; steps: GitImportStep[]; parsed: ParsedRepoUrl }
  | { ok: false; reason: "empty" | "unsupported_scheme" | "missing_owner_or_repo" };

/** Build the ordered step list. Caller advances through `steps` and reports
 * back which one is in-progress / done. */
export function planImportFromGit(inputs: PlanImportInputs): PlanImportResult {
  const parsed = parseRepoUrl(inputs.url);
  if (!parsed.ok) return parsed;

  const steps: GitImportStep[] = [
    {
      kind: "validate_url",
      label: `Validate URL ${parsed.parsed.raw}`,
      payload: { parsed: parsed.parsed },
    },
    {
      kind: "ensure_target_folder",
      label: `Prepare target folder ${inputs.targetFolderAbs}`,
      payload: { targetFolderAbs: inputs.targetFolderAbs },
    },
    {
      kind: "git_clone",
      label: `git clone ${parsed.parsed.raw} ${inputs.targetFolderAbs}`,
      payload: { url: parsed.parsed.raw, targetFolderAbs: inputs.targetFolderAbs },
    },
    {
      kind: "read_gitignore",
      label: "Read .gitignore from target folder",
      payload: { targetFolderAbs: inputs.targetFolderAbs },
    },
    {
      kind: "translate_to_vscodesync_ignore",
      label: "Translate .gitignore → .vscodesync-ignore",
    },
    {
      kind: "scan_files",
      label: "Scan target folder for trackable files",
    },
    {
      kind: "create_workspace",
      label: `Create VSCodeSync workspace ${parsed.parsed.repo}`,
      payload: { workspaceName: parsed.parsed.repo },
    },
    {
      kind: "add_files",
      label: "Add files to workspace",
    },
  ];
  return { ok: true, steps, parsed: parsed.parsed };
}
