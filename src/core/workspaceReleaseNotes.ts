/**
 * v0.16 N13 — pure builder for `RELEASE-NOTES.md` from a tag/version
 * history.
 *
 * Use case: a team archives sync'd workspace'ов periodically with version
 * tags ("v1.0", "v1.1"). This helper aggregates manifest-recorded
 * activity between two tags into a structured changelog (added / modified
 * / removed files) for paste into RELEASE-NOTES.md.
 */

export interface ReleaseNotesInput {
  /** Manifest snapshot at the from-tag. */
  fromFiles: readonly { path: string; version: number }[];
  /** Manifest snapshot at the to-tag. */
  toFiles: readonly { path: string; version: number }[];
  /** Version label "v1.0" / "v1.1". */
  fromTag?: string;
  toTag?: string;
  /** ISO timestamp shown in the header. */
  generatedAtIso?: string;
}

export interface ReleaseNotesReport {
  /** Files added between fromTag and toTag. */
  added: string[];
  /** Files whose version bumped. */
  modified: string[];
  /** Files removed. */
  removed: string[];
  /** Net change in file count. */
  netDelta: number;
}

export function buildReleaseNotes(input: ReleaseNotesInput): ReleaseNotesReport {
  const fromMap = new Map<string, number>();
  for (const f of input.fromFiles) fromMap.set(f.path, f.version);
  const toMap = new Map<string, number>();
  for (const f of input.toFiles) toMap.set(f.path, f.version);

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const [path, ver] of toMap.entries()) {
    const prev = fromMap.get(path);
    if (prev === undefined) added.push(path);
    else if (prev !== ver) modified.push(path);
  }
  for (const path of fromMap.keys()) {
    if (!toMap.has(path)) removed.push(path);
  }

  added.sort();
  modified.sort();
  removed.sort();

  return {
    added,
    modified,
    removed,
    netDelta: toMap.size - fromMap.size,
  };
}

export function formatReleaseNotesMarkdown(
  report: ReleaseNotesReport,
  input: ReleaseNotesInput,
): string {
  const ts = input.generatedAtIso ?? new Date().toISOString();
  const lines: string[] = [];
  lines.push(`# Release notes ${input.fromTag ?? "?"} → ${input.toTag ?? "?"}`);
  lines.push("");
  lines.push(`Generated: ${ts}`);
  lines.push("");
  if (report.added.length > 0) {
    lines.push("## Added");
    lines.push("");
    for (const p of report.added) lines.push(`- \`${p}\``);
    lines.push("");
  }
  if (report.modified.length > 0) {
    lines.push("## Modified");
    lines.push("");
    for (const p of report.modified) lines.push(`- \`${p}\``);
    lines.push("");
  }
  if (report.removed.length > 0) {
    lines.push("## Removed");
    lines.push("");
    for (const p of report.removed) lines.push(`- \`${p}\``);
    lines.push("");
  }
  if (report.added.length === 0 && report.modified.length === 0 && report.removed.length === 0) {
    lines.push("_(no changes detected between snapshots)_");
  }
  return lines.join("\n");
}
