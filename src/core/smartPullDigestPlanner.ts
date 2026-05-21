/**
 * F1 — Smart Pull Digest: aggregate «what colleagues changed».
 *
 * Pure module. Input: tracked files snapshot. Output: grouped digest
 * suitable for a notification headline + Markdown body (or for the
 * Activity panel webview).
 *
 * Grouping priority: by `editingByName` if known, else by workspace.
 */

export interface DigestInputFile {
  workspaceId: string;
  workspaceNote?: string;
  localPath: string;
  syncStatus?: string;
  editingBy?: string;
  editingByName?: string;
  lastSync?: string;
}

export interface DigestGroup {
  /** Either a machine label (editingByName) or a workspace label. */
  groupLabel: string;
  kind: "machine" | "workspace";
  files: { localPath: string; workspaceNote?: string }[];
}

export interface DigestSummary {
  totalCloudNewer: number;
  totalConflicts: number;
  groups: DigestGroup[];
  /** Single-line headline for status bar / toast. */
  headline: string;
  /** Markdown body suitable for a notification or webview. */
  markdown: string;
}

export function buildSmartPullDigest(files: DigestInputFile[]): DigestSummary {
  const cloudNewer = files.filter((f) => f.syncStatus === "cloud_newer");
  const conflicts = files.filter((f) => f.syncStatus === "conflict");
  const byMachine = new Map<string, DigestGroup>();
  const byWorkspace = new Map<string, DigestGroup>();
  for (const f of cloudNewer) {
    const machine = f.editingByName ?? f.editingBy;
    if (machine) {
      const g = byMachine.get(machine) ?? { groupLabel: machine, kind: "machine" as const, files: [] };
      g.files.push({ localPath: f.localPath, workspaceNote: f.workspaceNote });
      byMachine.set(machine, g);
      continue;
    }
    const wsLabel = f.workspaceNote ?? f.workspaceId.slice(0, 8);
    const g = byWorkspace.get(wsLabel) ?? { groupLabel: wsLabel, kind: "workspace" as const, files: [] };
    g.files.push({ localPath: f.localPath, workspaceNote: f.workspaceNote });
    byWorkspace.set(wsLabel, g);
  }
  const groups: DigestGroup[] = [
    ...[...byMachine.values()].sort((a, b) => b.files.length - a.files.length),
    ...[...byWorkspace.values()].sort((a, b) => b.files.length - a.files.length),
  ];
  const headline =
    cloudNewer.length === 0 && conflicts.length === 0
      ? "VSCodeSync: ничего нового от коллег."
      : `VSCodeSync: ${String(cloudNewer.length)} файл(ов) обновлено${
          conflicts.length > 0 ? `, ${String(conflicts.length)} конфликт(ов)` : ""
        }.`;
  const mdLines: string[] = [];
  if (cloudNewer.length === 0 && conflicts.length === 0) {
    mdLines.push("Все tracked-файлы синхронизированы. Ничего скачивать не нужно.");
  } else {
    if (groups.length > 0) {
      mdLines.push("### Обновлено коллегами\n");
      for (const g of groups) {
        const icon = g.kind === "machine" ? "✏️" : "📁";
        mdLines.push(`**${icon} ${g.groupLabel}** — ${String(g.files.length)} файл(ов):`);
        for (const f of g.files.slice(0, 5)) {
          mdLines.push(`  - \`${f.localPath}\``);
        }
        if (g.files.length > 5) {
          mdLines.push(`  - … ещё ${String(g.files.length - 5)}`);
        }
        mdLines.push("");
      }
    }
    if (conflicts.length > 0) {
      mdLines.push(`### ⚠ Конфликты (${String(conflicts.length)})\n`);
      for (const c of conflicts.slice(0, 10)) {
        mdLines.push(`- \`${c.localPath}\``);
      }
    }
  }
  return {
    totalCloudNewer: cloudNewer.length,
    totalConflicts: conflicts.length,
    groups,
    headline,
    markdown: mdLines.join("\n"),
  };
}
