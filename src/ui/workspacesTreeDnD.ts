import * as vscode from "vscode";
import * as path from "node:path";
import type { SyncTreeElement } from "./workspacesTree.js";
import { assertWorkspaceTrusted } from "./workspaceTrust.js";
import type { CanonicalRenameRequest } from "../core/plan/planCanonicalRename.js";

/** Payload for drag; includes tree mime so drops work within the same TreeView. */
const MIME_PAYLOAD = "application/vnd.vscodesync.sync-tree-file-move";
const MIME_TREE = "application/vnd.code.tree.vscodesync.workspaces";

export interface WorkspacesTreeDnDDeps {
  onMoveFilesToWorkspace(args: {
    folderRoot: string;
    targetWorkspaceId: string;
    sources: readonly { workspaceId: string; localPath: string; workspaceNote?: string }[];
  }): Promise<void>;
  /**
   * Canonical path editing: a drop INSIDE one workspace moves cloud keys, not
   * bytes — the handler funnels into the shared preview + confirm flow.
   */
  onCanonicalMove(args: {
    folderRoot: string;
    workspaceId: string;
    requests: readonly CanonicalRenameRequest[];
  }): Promise<void>;
}

interface DragRow {
  kind: "file" | "folder";
  folderRoot: string;
  workspaceId: string;
  /** File rows only — what the cross-workspace move consumes. */
  localPath?: string;
  /** Canonical key (file) or canonical prefix (folder) — what a canonical move consumes. */
  canonicalKey: string;
  workspaceNote?: string;
}

function isDragRow(p: unknown): p is DragRow {
  return (
    typeof p === "object" &&
    p !== null &&
    "kind" in p &&
    ((p as DragRow).kind === "file" || (p as DragRow).kind === "folder") &&
    typeof (p as DragRow).folderRoot === "string" &&
    typeof (p as DragRow).workspaceId === "string" &&
    typeof (p as DragRow).canonicalKey === "string"
  );
}

const lastSegment = (p: string): string => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);

export class WorkspacesTreeDnD implements vscode.TreeDragAndDropController<SyncTreeElement> {
  readonly dropMimeTypes = [MIME_PAYLOAD, MIME_TREE];
  readonly dragMimeTypes = [MIME_PAYLOAD];

  constructor(private readonly deps: WorkspacesTreeDnDDeps) {}

  handleDrag(source: readonly SyncTreeElement[], dataTransfer: vscode.DataTransfer): void {
    const payload: DragRow[] = [];
    for (const e of source) {
      if (e.kind === "file") {
        payload.push({
          kind: "file",
          folderRoot: e.folderRoot.fsPath,
          workspaceId: e.workspaceId,
          localPath: e.localPath,
          canonicalKey: e.manifestPath ?? e.localPath,
          workspaceNote: e.workspaceNote,
        });
      } else if (e.kind === "fileFolder") {
        payload.push({
          kind: "folder",
          folderRoot: e.folderRoot.fsPath,
          workspaceId: e.workspaceId,
          canonicalKey:
            e.space === "canonical" ? e.localPrefix : (e.canonicalPrefix ?? e.localPrefix),
          workspaceNote: e.workspaceNote,
        });
      }
    }
    if (payload.length === 0) {
      return;
    }
    dataTransfer.set(MIME_PAYLOAD, new vscode.DataTransferItem(JSON.stringify(payload)));
  }

  async handleDrop(target: SyncTreeElement | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const rawItem = dataTransfer.get(MIME_PAYLOAD);
    const val: unknown = rawItem?.value;
    if (typeof val !== "string") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(val) as unknown;
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return;
    }
    const rows = parsed.filter(isDragRow);
    if (rows.length === 0) {
      return;
    }

    const folderRoot = rows[0]?.folderRoot;
    if (!folderRoot || rows.some((r) => r.folderRoot !== folderRoot)) {
      await vscode.window.showWarningMessage("VSCodeSync: все элементы перетаскивания должны быть из одной корневой папки.");
      return;
    }

    if (target === undefined || (target.kind !== "workspace" && target.kind !== "fileFolder")) {
      // The old handler returned silently here — a dropped node just snapped
      // back with no explanation.
      vscode.window.setStatusBarMessage(
        "VSCodeSync: бросать можно на воркспейс или папку дерева",
        4000,
      );
      return;
    }
    if (target.folderRoot.fsPath !== folderRoot) {
      await vscode.window.showWarningMessage(
        "VSCodeSync: перетащите элемент на workspace той же корневой папки.",
      );
      return;
    }
    if (!(await assertWorkspaceTrusted())) {
      return;
    }

    // Inside ONE workspace a drop is a canonical move: keys travel, bytes stay.
    const sameWs = rows.filter((r) => r.workspaceId === target.workspaceId);
    if (sameWs.length > 0) {
      const targetPrefix =
        target.kind === "fileFolder"
          ? target.space === "canonical"
            ? target.localPrefix
            : (target.canonicalPrefix ?? target.localPrefix)
          : "";
      const requests: CanonicalRenameRequest[] = sameWs.map((r) => {
        const to = targetPrefix === "" ? lastSegment(r.canonicalKey) : `${targetPrefix}/${lastSegment(r.canonicalKey)}`;
        return { scope: r.kind === "folder" ? "prefix" : "file", from: r.canonicalKey, to };
      });
      await this.deps.onCanonicalMove({ folderRoot, workspaceId: target.workspaceId, requests });
      return;
    }

    // Across workspaces the existing move (remove + add) applies to files only.
    if (target.kind !== "workspace") {
      vscode.window.setStatusBarMessage(
        "VSCodeSync: перенос между воркспейсами — бросайте на узел воркспейса",
        4000,
      );
      return;
    }
    const sources = rows.filter(
      (r): r is DragRow & { localPath: string } =>
        r.kind === "file" && r.workspaceId !== target.workspaceId && typeof r.localPath === "string",
    );
    if (sources.length === 0) {
      vscode.window.setStatusBarMessage(
        "VSCodeSync: папки между воркспейсами не переносятся — перетащите файлы",
        4000,
      );
      return;
    }

    const targetLabel = target.note.trim().length > 0 ? target.note : target.workspaceId;
    const noteOf = (r: DragRow): string => r.workspaceNote?.trim() ?? r.workspaceId;
    let confirmMsg: string;
    if (sources.length === 1 && sources[0]) {
      const s = sources[0];
      confirmMsg = `Переместить «${path.basename(s.localPath)}» из «${noteOf(s)}» в «${targetLabel}»?`;
    } else {
      confirmMsg = `Переместить ${String(sources.length)} файл(ов) в workspace «${targetLabel}»?`;
    }

    const picked = await vscode.window.showWarningMessage(confirmMsg, { modal: true }, "Переместить", "Отмена");
    if (picked !== "Переместить") {
      return;
    }

    await this.deps.onMoveFilesToWorkspace({
      folderRoot,
      targetWorkspaceId: target.workspaceId,
      sources,
    });
  }
}
