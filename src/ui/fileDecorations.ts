import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { computeHash, type HashConfig } from "../utils/hash.js";
import { trackedPosixRelFor } from "../core/trackedPathResolver.js";

function decoHashConfig(): HashConfig {
  // The canonical hash is always LF since 1.0.0 — the `lineEnding` setting is
  // gone (stage 3.4, C25) and the engine hardcodes the same value.
  return { lineEnding: "lf" };
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
  else if (tf.syncStatus === "missing_local") parts.push("✕ Нет на диске — Pull или привяжите файл");
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
      const rel = await trackedPosixRelFor(folder.uri.fsPath, uri.fsPath);
      if (rel === undefined) return undefined;
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
      if (tf.syncStatus === "missing_local") {
        return new vscode.FileDecoration(
          "✕",
          tooltip,
          new vscode.ThemeColor("gitDecoration.deletedResource"),
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
      // An unreadable/absent file must not read as synced (the pre-Link
      // Bindings bug: hash "" skipped the modified branch → "✓").
      if (curHash === "") {
        return new vscode.FileDecoration(
          "✕",
          "✕ Нет на диске — Pull или привяжите файл · " + tooltip,
          new vscode.ThemeColor("gitDecoration.deletedResource"),
        );
      }
      return new vscode.FileDecoration("✓", tooltip, undefined);
    })();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
