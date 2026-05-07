import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Lists local and remote-tracking branch short names (best-effort via `git`). */
export async function listGitBranches(projectRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "-a", "--format=%(refname:short)"], {
      cwd: projectRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    const raw = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return [...new Set(raw)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  } catch {
    return [];
  }
}
