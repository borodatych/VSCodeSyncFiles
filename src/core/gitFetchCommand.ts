/**
 * v3.L — pure helper for the `git fetch` invocation that the engine hook in
 * `branchMismatchPlanner` will spawn when the action is `offer_fetch` /
 * `auto_fetch`.
 *
 * Mirrors the shape of `buildGitCloneCommand` (`gitCloneCommand.ts`); they
 * share `sanitiseEnv` so a single unit-test surface covers env safety for
 * every git invocation in the codebase.
 *
 * No `vscode` import. No actual spawn here.
 */

import { sanitiseEnv } from "./gitCloneCommand.js";

export interface GitFetchCommandOptions {
  /** Absolute path to the repo root (cwd for the spawn). */
  repoDirAbs: string;
  /** Optional remote name. Default `origin`. */
  remote?: string;
  /** Optional refspec / branch to fetch. When omitted, fetches all configured
   * refs for the remote. */
  branch?: string;
  /** When true, append `--prune` to drop deleted upstream refs. */
  prune?: boolean;
  /** When true, append `--tags`. */
  tags?: boolean;
  /** When set, append `--depth N` for shallow fetch. */
  depth?: number;
}

export type BuildGitFetchCommandResult =
  | { ok: true; argv: string[]; cwd: string; env: NodeJS.ProcessEnv }
  | { ok: false; reason: "empty_repo_dir" | "unsafe_remote" | "unsafe_branch" | "depth_invalid" };

export function buildGitFetchCommand(options: GitFetchCommandOptions): BuildGitFetchCommandResult {
  if (options.repoDirAbs.trim().length === 0) {
    return { ok: false, reason: "empty_repo_dir" };
  }
  const remote = options.remote ?? "origin";
  // Reject names that look like CLI flags. Git's `--` separator below covers
  // positional safety, but a remote/branch starting with `-` would still be
  // passed before `--` because git wants the remote/refspec in front.
  if (remote.startsWith("-")) {
    return { ok: false, reason: "unsafe_remote" };
  }
  if (options.branch?.startsWith("-") === true) {
    return { ok: false, reason: "unsafe_branch" };
  }
  if (options.depth !== undefined) {
    if (!Number.isInteger(options.depth) || options.depth < 1) {
      return { ok: false, reason: "depth_invalid" };
    }
  }

  const argv: string[] = ["fetch"];
  if (options.prune === true) argv.push("--prune");
  if (options.tags === true) argv.push("--tags");
  if (options.depth !== undefined) {
    argv.push("--depth", String(options.depth));
  }
  argv.push("--", remote);
  if (options.branch !== undefined && options.branch.length > 0) {
    argv.push(options.branch);
  }

  return {
    ok: true,
    argv,
    cwd: options.repoDirAbs,
    env: sanitiseEnv(),
  };
}
