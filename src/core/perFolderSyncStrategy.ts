/**
 * v3.J — pure parser + resolver for `.vscodesync-strategy`.
 *
 * Syntax (per line):
 *   <pattern>   <strategy>
 *
 * Patterns: gitignore-ish globs, same shape the ignore rules use.
 * Strategies: never | local-only | p2p-only | cloud (default).
 *
 * Example:
 *   node_modules/   never
 *   secrets/        p2p-only
 *   .vscode/        local-only
 *   *               cloud
 *
 * Resolver: first matching pattern wins (top-to-bottom). Files with no
 * match default to "cloud" (preserves v1 behaviour).
 *
 * No `vscode` import.
 */

export type SyncStrategy = "never" | "local-only" | "p2p-only" | "cloud";

const VALID_STRATEGIES: ReadonlySet<SyncStrategy> = new Set([
  "never",
  "local-only",
  "p2p-only",
  "cloud",
]);

export interface StrategyRule {
  pattern: string;
  strategy: SyncStrategy;
  /** Trailing slash → directory pattern. */
  dirOnly: boolean;
}

export type ParseStrategyResult =
  | { ok: true; rules: StrategyRule[] }
  | { ok: false; reason: "syntax"; line: number };

export function parseStrategyFile(text: string): ParseStrategyResult {
  const rules: StrategyRule[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    // Split by whitespace into 2 fields (pattern, strategy).
    const parts = raw.split(/\s+/);
    if (parts.length !== 2) return { ok: false, reason: "syntax", line: i + 1 };
    const [pattern, strategy] = parts;
    if (!VALID_STRATEGIES.has(strategy as SyncStrategy)) {
      return { ok: false, reason: "syntax", line: i + 1 };
    }
    const dirOnly = pattern.endsWith("/");
    rules.push({
      pattern: dirOnly ? pattern.slice(0, -1).replace(/^\/+/, "") : pattern.replace(/^\/+/, ""),
      strategy: strategy as SyncStrategy,
      dirOnly,
    });
  }
  return { ok: true, rules };
}

/** First matching rule wins. Default fallback: "cloud". */
export function resolveStrategy(relPath: string, rules: StrategyRule[]): SyncStrategy {
  for (const r of rules) {
    if (matchesPattern(relPath, r)) return r.strategy;
  }
  return "cloud";
}

function matchesPattern(relPath: string, rule: StrategyRule): boolean {
  const re = globToRegex(rule.pattern, rule.dirOnly);
  return re.test(relPath);
}

function globToRegex(glob: string, dirOnly: boolean): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 2;
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
  return dirOnly ? new RegExp(`^${re}(?:/|$)`) : new RegExp(`^${re}$`);
}
