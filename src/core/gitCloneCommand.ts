/**
 * v3.E — pure helper that turns a parsed repo URL into the exact
 * `git clone` argv + safe ENV the engine should pass to
 * `child_process.spawn`. The point of separating this from
 * `gitImportFromUrl` (which only enumerates steps) is to keep argv
 * construction unit-testable: bad argv leads to credential leakage or
 * out-of-tree writes, and we want regression tests around it.
 *
 * No `vscode` import. No actual spawn here — caller is responsible for
 * `child_process.spawn("git", argv, { cwd, env })` and stream handling.
 */

export interface GitCloneCommandOptions {
  /** Validated URL (https / ssh) — caller passes the raw form (`parseRepoUrl`
   * already validated it). */
  url: string;
  /** Absolute path of the *parent* directory the new clone lands in.
   * Caller has ensured it exists and is writable. */
  parentDirAbs: string;
  /** Target folder name inside `parentDirAbs`. The clone command appends
   * this so git creates the folder itself. */
  folderName: string;
  /** Optional shallow-clone depth (1 = HEAD only). Default unset → full clone. */
  depth?: number;
  /** Optional branch / tag / commit to check out after clone. */
  branch?: string;
  /** Optional: run `git submodule update --init --recursive` flag baked into
   * the clone via `--recurse-submodules`. */
  recurseSubmodules?: boolean;
}

export type BuildGitCloneCommandResult =
  | { ok: true; argv: string[]; cwd: string; env: NodeJS.ProcessEnv }
  | { ok: false; reason: "empty_url" | "empty_folder_name" | "unsafe_folder_name" | "depth_invalid" };

/** Strip env vars that could redirect git's working area (GIT_DIR,
 * GIT_WORK_TREE) or hijack credentials (GIT_ASKPASS, SSH_ASKPASS,
 * GIT_TERMINAL_PROMPT bypass). Caller may merge their own minimal env on
 * top — we do not auto-inherit `process.env` from the engine to avoid
 * accidental leaks. */
const SANITISED_ENV_VARS: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
]);

const UNSAFE_FOLDER_NAME_RE = /(^\.{1,2}$)|[/\\:]|^-/;

/** Build the argv + cwd + env triple. Returns a discriminated union so the
 * caller can short-circuit on validation failures without try/catch. */
export function buildGitCloneCommand(options: GitCloneCommandOptions): BuildGitCloneCommandResult {
  if (options.url.trim().length === 0) {
    return { ok: false, reason: "empty_url" };
  }
  if (options.folderName.trim().length === 0) {
    return { ok: false, reason: "empty_folder_name" };
  }
  if (UNSAFE_FOLDER_NAME_RE.test(options.folderName)) {
    return { ok: false, reason: "unsafe_folder_name" };
  }
  if (options.depth !== undefined) {
    if (!Number.isInteger(options.depth) || options.depth < 1) {
      return { ok: false, reason: "depth_invalid" };
    }
  }

  const argv: string[] = ["clone"];
  if (options.depth !== undefined) {
    argv.push("--depth", String(options.depth));
  }
  if (options.branch !== undefined && options.branch.length > 0) {
    argv.push("--branch", options.branch);
  }
  if (options.recurseSubmodules === true) {
    argv.push("--recurse-submodules");
  }
  argv.push("--", options.url, options.folderName);

  const env = sanitiseEnv();
  return {
    ok: true,
    argv,
    cwd: options.parentDirAbs,
    env,
  };
}

/** Caller can pass their own baseline env explicitly; otherwise we start
 * from `process.env` and strip the dangerous-for-git keys. */
export function sanitiseEnv(baseline: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(baseline)) {
    if (SANITISED_ENV_VARS.has(k)) continue;
    out[k] = v;
  }
  // Force non-interactive — interactive prompts would hang the spawn.
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}
