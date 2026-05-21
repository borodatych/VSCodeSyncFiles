/**
 * v0.8 F-009 — pure helper for the "keep both" conflict resolution.
 *
 * Plan shape:
 *   - LOCAL stays under the original posix-rel (will be pushed).
 *   - CLOUD ("theirs") is written to a sibling file with `.conflict-<machine>-<ts>`
 *     suffix injected before the file extension.
 *   - A pre-resolve backup of the LOCAL content lands in a per-workspace
 *     backup dir (default `.vscode/vscodesync-local-backup/conflict-<ts>/<rel>`,
 *     but the engine resolves this via the `vscodesync.localBackupDir`
 *     setting — actual location may differ for users with an override).
 *
 * No `fs` / `vscode` import — caller wires the actual filesystem ops.
 */

export interface KeepBothPlan {
  /** Original posix-rel — caller will push LOCAL content here. */
  localRel: string;
  /** Sibling posix-rel that should receive CLOUD bytes. */
  theirsRel: string;
  /** Suggested backup folder name under `.vscode/vscodesync-local-backup/`. */
  backupFolderName: string;
}

export interface KeepBothInput {
  posixRel: string;
  /** Identifier of the *other* machine (the one whose version becomes "theirs"). */
  remoteMachineLabel: string;
  /** Optional override for "now" — used by tests. */
  nowIso?: string;
}

/** Сanonise a string into a portable filename fragment: only `A-Za-z0-9-_`. */
function sanitiseFragment(raw: string): string {
  const out = raw
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    // Re-trim trailing dashes after slice — they can appear if the 40th
    // character lands on a hyphen run.
    .replace(/-+$/g, "");
  return out.length > 0 ? out : "machine";
}

/** Strip filesystem-unsafe characters from a timestamp into `2026-05-21T11-22-33-456Z`. */
function sanitiseTs(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/** Split a posix-rel into `dir`, `stem`, `ext`. `ext` includes the leading dot. */
function splitName(rel: string): { dir: string; stem: string; ext: string } {
  const lastSlash = rel.lastIndexOf("/");
  const dir = lastSlash >= 0 ? rel.slice(0, lastSlash + 1) : "";
  const base = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
  // Multi-dot files (.tar.gz, .d.ts) — only split on the last dot to keep
  // the rest in the stem. Hidden files starting with `.` keep no extension.
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === base.length - 1) {
    return { dir, stem: base, ext: "" };
  }
  return { dir, stem: base.slice(0, dotIdx), ext: base.slice(dotIdx) };
}

export function planKeepBothResolution(input: KeepBothInput): KeepBothPlan {
  const { posixRel, remoteMachineLabel } = input;
  const ts = sanitiseTs(input.nowIso ?? new Date().toISOString());
  const machine = sanitiseFragment(remoteMachineLabel);
  const { dir, stem, ext } = splitName(posixRel);
  const theirsRel = `${dir}${stem}.conflict-${machine}-${ts}${ext}`;
  const backupFolderName = `conflict-${ts}`;
  return {
    localRel: posixRel,
    theirsRel,
    backupFolderName,
  };
}
