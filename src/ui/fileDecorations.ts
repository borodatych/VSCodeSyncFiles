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

function formatRelative(iso: string | undefined): string {
  if (!iso) return "никогда";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000) return "только что";
  if (diff < 3_600_000) return `${String(Math.floor(diff / 60_000))} мин назад`;
  if (diff < 86_400_000) return `${String(Math.floor(diff / 3_600_000))} ч назад`;
  return `${String(Math.floor(diff / 86_400_000))} д назад`;
}

interface TrackedLike {
  workspaceId: string;
  lastSync?: string;
  syncStatus?: string;
  editingBy?: string;
  editingByName?: string;
}

function buildTooltip(tf: TrackedLike): string {
  const parts: string[] = [];
  if (tf.syncStatus === "conflict") parts.push("⚠ Конфликт — разрешите вручную");
  else if (tf.syncStatus === "cloud_newer") parts.push("↓ Облако новее — Pull");
  else if (tf.syncStatus === "pending_push") parts.push("↑ Ожидает отправки");
  else parts.push("✓ Синхронизирован");
  parts.push(`Last sync: ${formatRelative(tf.lastSync)}`);
  if (tf.editingByName ?? tf.editingBy) {
    parts.push(`Editing on: ${tf.editingByName ?? tf.editingBy ?? "unknown"}`);
  }
  parts.push(`Workspace: ${tf.workspaceId.slice(0, 8)}…`);
  return parts.join(" · ");
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
      // B7 — honour the CancellationToken at every async boundary. Without
      // this a slow async chain (cfg load → hash) could resolve AFTER a
      // newer call already produced a decoration, overwriting fresh state
      // with stale.
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      if (token.isCancellationRequested) return undefined;
      const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
      const tf = wc.files.find((f) => f.localPath === rel);
      if (!tf) {
        return undefined;
      }
      const tooltip = buildTooltip(tf);
      if (tf.syncStatus === "conflict") {
        return new vscode.FileDecoration(
          "⚠",
          tooltip,
          new vscode.ThemeColor("gitDecoration.conflictingResource"),
        );
      }
      if (tf.syncStatus === "pending_push") {
        return new vscode.FileDecoration(
          "↑",
          tooltip,
          new vscode.ThemeColor("gitDecoration.modifiedResource"),
        );
      }
      if (tf.syncStatus === "cloud_newer") {
        return new vscode.FileDecoration(
          "↓",
          tooltip,
          new vscode.ThemeColor("gitDecoration.untrackedResource"),
        );
      }
      const curHash = await computeHash(uri.fsPath, decoHashConfig()).catch(() => "");
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- token.isCancellationRequested mutates during the await
      if (token.isCancellationRequested) return undefined;
      if (curHash !== "" && curHash !== tf.localHash) {
        return new vscode.FileDecoration(
          "↑",
          tooltip,
          new vscode.ThemeColor("gitDecoration.modifiedResource"),
        );
      }
      return new vscode.FileDecoration("✓", tooltip, undefined);
    })();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
