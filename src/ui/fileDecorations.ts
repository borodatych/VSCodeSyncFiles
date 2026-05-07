import * as vscode from "vscode";
import * as path from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { computeHash, type HashConfig } from "../utils/hash.js";
import type { LineEndingMode } from "../utils/normalize.js";

function decoHashConfig(): HashConfig {
  const raw = vscode.workspace.getConfiguration("vscodesync").get<string>("lineEnding", "lf");
  const lineEnding: LineEndingMode = raw === "crlf" || raw === "preserve" ? raw : "lf";
  return { lineEnding };
}

export class SyncFileDecorationController implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  setSyncInProgress(_on: boolean): void {
    this.emitter.fire(undefined);
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
    void token;
    if (uri.scheme !== "file") {
      return undefined;
    }
    const enabled = vscode.workspace.getConfiguration("vscodesync").get<boolean>("showFileDecorations", true);
    if (!enabled) {
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    return (async () => {
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
      const tf = wc.files.find((f) => f.localPath === rel);
      if (!tf) {
        return undefined;
      }
      if (tf.syncStatus === "conflict") {
        return new vscode.FileDecoration(
          "⚠",
          "Конфликт синхронизации",
          new vscode.ThemeColor("gitDecoration.conflictingResource"),
        );
      }
      if (tf.syncStatus === "pending_push") {
        return new vscode.FileDecoration(
          "↑",
          "Ожидает отправки",
          new vscode.ThemeColor("gitDecoration.modifiedResource"),
        );
      }
      if (tf.syncStatus === "cloud_newer") {
        return new vscode.FileDecoration(
          "↓",
          "Облако новее — нажмите «Получить файл» для обновления",
          new vscode.ThemeColor("gitDecoration.untrackedResource"),
        );
      }
      const curHash = await computeHash(uri.fsPath, decoHashConfig()).catch(() => "");
      if (curHash !== "" && curHash !== tf.localHash) {
        return new vscode.FileDecoration(
          "↑",
          "Локально изменён относительно последнего sync",
          new vscode.ThemeColor("gitDecoration.modifiedResource"),
        );
      }
      return new vscode.FileDecoration("✓", "Синхронизирован", undefined);
    })();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
