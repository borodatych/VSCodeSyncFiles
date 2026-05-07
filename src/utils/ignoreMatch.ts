/**
 * Minimal gitignore-compatible pattern matching.
 * Handles: wildcards `*` `**` `?`, negation `!`, directory suffix `/`, comments `#`.
 */

export interface IgnoreRule {
  negate: boolean;
  pattern: string;
  directoryOnly: boolean;
}

export function parseIgnoreRules(text: string): IgnoreRule[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const negate = line.startsWith("!");
      let pat = negate ? line.slice(1) : line;
      const directoryOnly = pat.endsWith("/");
      if (directoryOnly) {
        pat = pat.slice(0, -1);
      }
      return { negate, pattern: pat, directoryOnly };
    });
}

function globToRegex(pattern: string): RegExp {
  let src = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      src += ".*";
      i += 2;
      if (pattern[i] === "/") {
        i += 1;
      }
    } else if (ch === "*") {
      src += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      src += "[^/]";
      i += 1;
    } else {
      src += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${src}$`);
}

function matchesPattern(posixRel: string, rule: IgnoreRule): boolean {
  const pat = rule.pattern;

  if (!pat.includes("/")) {
    const name = posixRel.includes("/") ? posixRel.slice(posixRel.lastIndexOf("/") + 1) : posixRel;
    const re = globToRegex(pat);
    if (re.test(name)) {
      return true;
    }
    const segRe = globToRegex(pat);
    return posixRel.split("/").some((seg) => segRe.test(seg));
  }

  const anchored = pat.startsWith("/") ? pat.slice(1) : pat;
  const re = globToRegex(anchored);
  if (re.test(posixRel)) {
    return true;
  }
  if (!pat.startsWith("/")) {
    const re2 = globToRegex(anchored);
    const parts = posixRel.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (re2.test(parts.slice(i).join("/"))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Returns `true` if `posixRelPath` is ignored by the given rules.
 * Only files are tested (not directory-only patterns, since we pass file paths).
 */
export function isIgnoredByRules(posixRelPath: string, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (matchesPattern(posixRelPath, rule)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}
