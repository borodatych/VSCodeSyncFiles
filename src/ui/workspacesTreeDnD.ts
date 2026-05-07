import * as vscode from "vscode";
import * as path from "node:path";
import type { SyncTreeElement } from "./workspacesTree.js";
import { assertWorkspaceTrusted } from "./workspaceTrust.js";

/** Payload for drag; includes tree mime so drops work within the same TreeView. */
const MIME_PAYLOAD = "application/vnd.vscodesync.sync-tree-file-move";
const MIME_TREE = "application/vnd.code.tree.vscodesync.workspaces";

export interface WorkspacesTreeDnDDeps {
  onMoveFilesToWorkspace(args: {
    folderRoot: string;
    targetWorkspaceId: string;
    sources: readonly { workspaceId: string; localPath: string; workspaceNote?: string }[];
  }): Promise<void>;
}

interface FileDragRow {
  folderRoot: string;
  workspaceId: string;
  localPath: string;
  workspaceNote?: string;
}

export class WorkspacesTreeDnD implements vscode.TreeDragAndDropController<SyncTreeElement> {
  readonly dropMimeTypes = [MIME_PAYLOAD, MIME_TREE];
  readonly dragMimeTypes = [MIME_PAYLOAD];

  constructor(private readonly deps: WorkspacesTreeDnDDeps) {}

  handleDrag(source: readonly SyncTreeElement[], dataTransfer: vscode.DataTransfer): void {
    const files = source.filter((e): e is Extract<SyncTreeElement, { kind: "file" }> => e.kind === "file");
    if (files.length === 0) {
      return;
    }
    const payload: FileDragRow[] = files.map((f) => ({
      folderRoot: f.folderRoot.fsPath,
      workspaceId: f.workspaceId,
      localPath: f.localPath,
      workspaceNote: f.workspaceNote,
    }));
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
    if (target?.kind !== "workspace") {
      return;
    }

    const rows: FileDragRow[] = [];
    for (const p of parsed) {
      if (
        typeof p === "object" &&
        p !== null &&
        "folderRoot" in p &&
        "workspaceId" in p &&
        "localPath" in p &&
        typeof (p as FileDragRow).folderRoot === "string" &&
        typeof (p as FileDragRow).workspaceId === "string" &&
        typeof (p as FileDragRow).localPath === "string"
      ) {
        rows.push(p as FileDragRow);
      }
    }
    if (rows.length === 0) {
      return;
    }

    const folderRoot = rows[0]?.folderRoot;
    if (!folderRoot || rows.some((r) => r.folderRoot !== folderRoot)) {
      await vscode.window.showWarningMessage("VSCodeSync: все элементы перетаскивания должны быть из одной корневой папки.");
      return;
    }

    if (target.folderRoot.fsPath !== folderRoot) {
      await vscode.window.showWarningMessage(
        "VSCodeSync: перетащите файл на workspace той же корневой папки, что и у файла.",
      );
      return;
    }

    const sources = rows.filter((r) => r.workspaceId !== target.workspaceId);
    if (sources.length === 0) {
      return;
    }

    if (!(await assertWorkspaceTrusted())) {
      return;
    }

    const targetLabel = target.note.trim().length > 0 ? target.note : target.workspaceId;
    const noteOf = (r: FileDragRow): string => r.workspaceNote?.trim() ?? r.workspaceId;
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
