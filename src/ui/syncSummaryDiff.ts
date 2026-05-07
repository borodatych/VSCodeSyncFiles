import type { WorkspaceConfig } from "../core/types.js";

const SEP = "\u0000";

export interface TrackedDiffLine {
  kind: "updated" | "added" | "removed";
  workspaceId: string;
  workspaceNote: string;
  localPath: string;
  folderRootFsPath: string;
}

function fileKey(workspaceId: string, localPath: string): string {
  return `${workspaceId}${SEP}${localPath}`;
}

/** Diff tracked rows between двумя снимками `vscodesync.json` одной корневой папки. */
export function diffTrackedSnapshots(
  before: WorkspaceConfig,
  after: WorkspaceConfig,
  folderRootFsPath: string,
): TrackedDiffLine[] {
  const notes = new Map<string, string>();
  for (const w of after.activeWorkspaces) {
    notes.set(w.workspaceId, w.workspaceNote);
  }

  const bm = new Map<string, (typeof before.files)[0]>();
  for (const f of before.files) {
    bm.set(fileKey(f.workspaceId, f.localPath), f);
  }
  const am = new Map<string, (typeof after.files)[0]>();
  for (const f of after.files) {
    am.set(fileKey(f.workspaceId, f.localPath), f);
  }

  const out: TrackedDiffLine[] = [];

  for (const [k, af] of am) {
    const bf = bm.get(k);
    const note = notes.get(af.workspaceId) ?? af.workspaceId;
    if (!bf) {
      out.push({
        kind: "added",
        workspaceId: af.workspaceId,
        workspaceNote: note,
        localPath: af.localPath,
        folderRootFsPath,
      });
      continue;
    }
    const hashChanged = bf.localHash !== af.localHash;
    const conflictAppeared = bf.syncStatus !== "conflict" && af.syncStatus === "conflict";
    if (hashChanged || conflictAppeared) {
      out.push({
        kind: "updated",
        workspaceId: af.workspaceId,
        workspaceNote: note,
        localPath: af.localPath,
        folderRootFsPath,
      });
    }
  }

  for (const [k, bf] of bm) {
    if (!am.has(k)) {
      const wid = bf.workspaceId;
      out.push({
        kind: "removed",
        workspaceId: wid,
        workspaceNote: notes.get(wid) ?? wid,
        localPath: bf.localPath,
        folderRootFsPath,
      });
    }
  }

  out.sort((a, b) => {
    const w = a.workspaceNote.localeCompare(b.workspaceNote, undefined, { sensitivity: "base" });
    if (w !== 0) {
      return w;
    }
    return a.localPath.localeCompare(b.localPath, undefined, { sensitivity: "base" });
  });
  return out;
}

export function formatRuSessionHint(prevIso: string | undefined, locale?: string): string {
  if (!prevIso) {
    return "первый запуск или ещё не было сохранённого сеанса";
  }
  let d: Date;
  try {
    d = new Date(prevIso);
  } catch {
    return prevIso;
  }
  if (Number.isNaN(d.getTime())) {
    return prevIso;
  }
  try {
    return d.toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return prevIso;
  }
}

function kindRu(kind: TrackedDiffLine["kind"]): string {
  switch (kind) {
    case "added":
      return "добавлен в workspace с облака";
    case "removed":
      return "убран из трекинга (файл может остаться локально)";
    case "updated":
      return "обновлено с облака";
    default:
      return "";
  }
}

export function buildSyncSummaryDetailText(lines: TrackedDiffLine[], hint: string): string {
  const header = `С прошлего сохранённого запуска: ${hint}`;
  if (lines.length === 0) {
    return header;
  }
  const parts: string[] = [header, ""];
  let curWs = "";
  for (const ln of lines) {
    const wsLabel = ln.workspaceNote || ln.workspaceId;
    if (wsLabel !== curWs) {
      curWs = wsLabel;
      parts.push(`🗂 ${wsLabel}`);
    }
    const sym = ln.kind === "added" ? "+" : ln.kind === "removed" ? "−" : "↓";
    parts.push(`   ${sym} ${ln.localPath}   ${kindRu(ln.kind)}`);
  }
  const body = parts.join("\n");
  return body.length > 12000 ? `${body.slice(0, 11997)}…` : body;
}
