/** Normalize per-workspace ignore pattern lines (gitignore-syntax), drop blanks and `#` comments, stable dedupe. */
export function normalizeIgnorePatternStrings(lines: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = typeof raw === "string" ? raw.trim() : "";
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

export function normalizeIgnorePatternLinesFromText(raw: string): string[] {
  return normalizeIgnorePatternStrings(raw.split(/\r?\n/));
}
