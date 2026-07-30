/**
 * Inline CodeLens at the top of every tracked file showing freshness and a
 * one-click Pull. Cheap: only reads `vscodesync.json` + manifest cache that
 * the engine already keeps. Disabled by setting `vscodesync.codeLens.enabled`.
 */
import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { trackedPosixRelFor } from "../core/trackedPathResolver.js";

function relativeAge(iso: string | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${String(Math.floor(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${String(Math.floor(diff / 3_600_000))}h ago`;
  return `${String(Math.floor(diff / 86_400_000))}d ago`;
}

export class SyncLastSyncCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const enabled = vscode.workspace
      .getConfiguration("vscodesync")
      .get<boolean>("codeLens.enabled", true);
    if (!enabled) return [];
    if (document.uri.scheme !== "file") return [];
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return [];

    let wc;
    try {
      wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
    } catch {
      return [];
    }
    const rel = await trackedPosixRelFor(folder.uri.fsPath, document.uri.fsPath);
    if (rel === undefined) return [];
    const tf = wc.files.find((f) => f.localPath === rel);
    if (!tf) return [];

    const range = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [];
    const editorLabel = tf.editingByName ?? tf.editingBy;
    const head = `$(cloud) VSCodeSync · last sync ${relativeAge(tf.lastSync)}`;
    lenses.push(
      new vscode.CodeLens(range, {
        title: editorLabel ? `${head} · editing on ${editorLabel}` : head,
        command: "vscodesync.openSyncSettings",
      }),
    );
    if (tf.syncStatus === "cloud_newer") {
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(arrow-down) Pull from cloud",
          command: "vscodesync.pullCurrentFile",
        }),
      );
    } else if (tf.syncStatus === "conflict") {
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(warning) Resolve conflict",
          command: "vscodesync.resolveConflicts",
        }),
      );
    }
    return lenses;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
