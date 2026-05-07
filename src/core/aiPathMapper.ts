/**
 * Pure prompt-builder for the AI Path Mapper feature. When a workspace is
 * attached on a new machine, configs (`launch.json`, `tasks.json`, `.env`,
 * `.vscode/settings.json`) often contain absolute paths from the previous
 * machine. This module:
 *
 *  1. Detects suspicious absolute paths via heuristics (no I/O — string-level).
 *  2. Builds an LM prompt asking for a remap to the current workspace root.
 *
 * The LM call lives in the wrapper (vscode.lm); this module is unit-testable.
 */

export interface PathRemapInput {
  /** Old workspace root we're migrating from (e.g. `/home/alice/Projects/myapp`). */
  oldRoot: string;
  /** New workspace root on this machine (e.g. `D:\Projects\myapp`). */
  newRoot: string;
  /**
   * The set of config-file contents to remap, keyed by relative path.
   * Caller reads them with vscode.workspace.fs; values are raw strings.
   */
  configs: Record<string, string>;
}

export const MAX_CONFIG_BYTES = 16_384;

const ABSOLUTE_HEURISTICS: readonly RegExp[] = [
  /\/(?:home|Users)\/[A-Za-z0-9_.\-/]+/g,           // POSIX home + arbitrary subpath
  /[A-Za-z]:[\\/](?:[^\s"'<>|*?]+[\\/])*[^\s"'<>|*?]*/g, // Windows path with drive
  /file:\/\/\/[^\s"'<>]+/g,                          // file:// URI
];

export interface SuspiciousPath {
  configPath: string;
  match: string;
  /** Line in the original file (1-based). */
  line: number;
}

/** Find absolute paths inside the configs that don't already match `newRoot`. */
export function findSuspiciousPaths(input: PathRemapInput): SuspiciousPath[] {
  const out: SuspiciousPath[] = [];
  const newRootNormalized = input.newRoot.replace(/\\/g, "/").toLowerCase();
  for (const [configPath, body] of Object.entries(input.configs)) {
    if (typeof body !== "string") continue;
    if (body.length > MAX_CONFIG_BYTES) continue;
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const re of ABSOLUTE_HEURISTICS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const match = m[0];
          const normalized = match.replace(/\\/g, "/").toLowerCase();
          if (normalized.startsWith(newRootNormalized)) continue;
          out.push({ configPath, match, line: i + 1 });
        }
      }
    }
  }
  return out;
}

export function buildPathMapperPrompt(input: PathRemapInput, suspicious: readonly SuspiciousPath[]): string {
  const trimmed = suspicious.slice(0, 40);
  const lines = trimmed.map(
    (s) => `- ${s.configPath}:${String(s.line)} → ${s.match}`,
  );
  return `You are migrating workspace configuration from one developer machine to another.

Old root: ${input.oldRoot}
New root: ${input.newRoot}

Below are absolute paths that probably need remapping. For each, return a JSON
array entry: {"configPath", "find", "replace"}. Use the new root verbatim, do
not invent any path that didn't exist in "find". Output JUST the JSON array,
no preamble.

${lines.join("\n")}`;
}

/** Minimal validator for the LM response: ensures every entry has the expected keys. */
export interface PathRemapEdit {
  configPath: string;
  find: string;
  replace: string;
}

export function parseRemapEdits(raw: string): PathRemapEdit[] {
  const trimmed = raw.trim();
  // Strip code fences if present.
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PathRemapEdit[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const x = item as Partial<PathRemapEdit>;
    if (
      typeof x.configPath !== "string" ||
      typeof x.find !== "string" ||
      typeof x.replace !== "string"
    ) continue;
    if (x.find.length === 0) continue;
    out.push({ configPath: x.configPath, find: x.find, replace: x.replace });
  }
  return out;
}

/** Apply a list of edits to a config body. Each `find` is replaced literally (not regex). */
export function applyRemapEdits(body: string, edits: readonly PathRemapEdit[]): string {
  let out = body;
  for (const e of edits) {
    out = out.split(e.find).join(e.replace);
  }
  return out;
}
