/**
 * v3.A — pure include/exclude filter for selective sync.
 *
 * Mode "all-tracked" (default v1 behaviour) — every tracked file syncs.
 * Mode "include-list" — only files matching at least one pattern in
 *                       `.vscodesync-include` sync.
 * Mode "exclude-list" — files NOT matching any pattern in
 *                       `.vscodesync-include` sync (i.e. include file is an
 *                       exclude-list when mode flips).
 *
 * Pattern syntax: minimal gitignore-style (no negation, no `!`). Supports
 * `*` and `**` segments, leading `/` for absolute, trailing `/` for
 * directories.
 *
 * No `vscode` import. Caller reads the file content separately and passes a
 * line array.
 */

export type SelectiveSyncMode = "all-tracked" | "include-list" | "exclude-list";

export interface SelectiveSyncEvalOptions {
  mode: SelectiveSyncMode;
  patterns: string[];
}

/** Returns true if the relative POSIX path should be synced under the given
 * mode + pattern set. */
export function evaluateSelectiveSync(relPath: string, options: SelectiveSyncEvalOptions): boolean {
  if (options.mode === "all-tracked") return true;
  const matches = options.patterns.some((p) => matchesPattern(relPath, p));
  if (options.mode === "include-list") return matches;
  return !matches; // exclude-list
}

/** Trim comments, blank lines, leading slashes; returns clean pattern list. */
export function parseSelectiveSyncFile(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    out.push(line.replace(/^\/+/, ""));
  }
  return out;
}

function matchesPattern(relPath: string, pattern: string): boolean {
  // Trailing slash → directory pattern; matches anything beneath it.
  let p = pattern;
  let dirOnly = false;
  if (p.endsWith("/")) {
    dirOnly = true;
    p = p.slice(0, -1);
  }
  const re = globToRegex(p, dirOnly);
  return re.test(relPath);
}

/** Translate a gitignore-ish glob to a RegExp. Supports `*`, `**`, `?`, plus
 * literal segments. Anchored at start; matches the entire path or a prefix
 * for dir patterns. */
function globToRegex(glob: string, dirOnly: boolean): RegExp {
  // Escape regex metacharacters except for our wildcard tokens.
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** — match any path component(s)
        re += ".*";
        i += 2;
        // Allow ** followed by / to be greedy across slashes.
        if (glob[i] === "/") i += 1;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += `\\${ch}`;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  // Anchor: start of path; end depends on dirOnly.
  return dirOnly ? new RegExp(`^${re}(?:/|$)`) : new RegExp(`^${re}$`);
}
