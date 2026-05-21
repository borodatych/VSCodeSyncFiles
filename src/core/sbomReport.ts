/**
 * v0.16 N07 — "what's shared" SBOM-style report.
 *
 * Lists every tracked file across all attached workspaces with size +
 * machines that have it locally. Useful for compliance audits and for
 * users who want to know "what did I accidentally share?"
 *
 * Pure: caller gathers manifests + machine registries and hands them in.
 */

export interface SbomTrackedFile {
  workspaceId: string;
  workspaceNote: string;
  posixRel: string;
  /** From `_meta.files[rel].size` if available; otherwise undefined. */
  bytes?: number;
  /** machineIds known to have this file in their `vscodesync.json`. */
  machineIds: string[];
  /** ISO of newest manifest activity for this file. */
  lastUpdatedIso?: string;
}

export interface SbomReport {
  generatedAtIso: string;
  workspaceCount: number;
  fileCount: number;
  totalBytes: number;
  files: SbomTrackedFile[];
  /** Per-workspace bytes (sorted desc). */
  byWorkspace: { workspaceId: string; workspaceNote: string; bytes: number; files: number }[];
}

export interface SbomInput {
  workspaces: {
    workspaceId: string;
    workspaceNote: string;
    files: { posixRel: string; bytes?: number; lastUpdatedIso?: string; machineIds: string[] }[];
  }[];
  nowIso?: string;
}

export function buildSbomReport(input: SbomInput): SbomReport {
  const files: SbomTrackedFile[] = [];
  const byWs = new Map<string, { workspaceNote: string; bytes: number; files: number }>();
  let total = 0;
  for (const w of input.workspaces) {
    let wsBytes = 0;
    for (const f of w.files) {
      const bytes = f.bytes ?? 0;
      total += bytes;
      wsBytes += bytes;
      files.push({
        workspaceId: w.workspaceId,
        workspaceNote: w.workspaceNote,
        posixRel: f.posixRel,
        bytes: f.bytes,
        machineIds: [...new Set(f.machineIds)],
        lastUpdatedIso: f.lastUpdatedIso,
      });
    }
    byWs.set(w.workspaceId, {
      workspaceNote: w.workspaceNote,
      bytes: wsBytes,
      files: w.files.length,
    });
  }
  files.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  const byWorkspace = [...byWs.entries()]
    .map(([workspaceId, v]) => ({ workspaceId, workspaceNote: v.workspaceNote, bytes: v.bytes, files: v.files }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    generatedAtIso: input.nowIso ?? new Date().toISOString(),
    workspaceCount: input.workspaces.length,
    fileCount: files.length,
    totalBytes: total,
    files,
    byWorkspace,
  };
}

/** Format the report as Markdown for the OutputChannel / file export. */
export function formatSbomMarkdown(report: SbomReport): string {
  const lines: string[] = [];
  lines.push(`# VSCodeSync · SBOM report`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAtIso}`);
  lines.push(`Workspaces: ${String(report.workspaceCount)}`);
  lines.push(`Files: ${String(report.fileCount)}`);
  lines.push(`Total bytes: ${String(report.totalBytes)}`);
  lines.push("");
  lines.push("## By workspace");
  lines.push("");
  lines.push("| Workspace | Files | Bytes |");
  lines.push("|---|---:|---:|");
  for (const w of report.byWorkspace) {
    lines.push(`| ${w.workspaceNote} | ${String(w.files)} | ${String(w.bytes)} |`);
  }
  lines.push("");
  lines.push("## Top 50 heaviest files");
  lines.push("");
  lines.push("| Workspace | Path | Bytes | Machines |");
  lines.push("|---|---|---:|---:|");
  for (const f of report.files.slice(0, 50)) {
    lines.push(
      `| ${f.workspaceNote} | ${f.posixRel} | ${String(f.bytes ?? "?")} | ${String(f.machineIds.length)} |`,
    );
  }
  return lines.join("\n");
}
