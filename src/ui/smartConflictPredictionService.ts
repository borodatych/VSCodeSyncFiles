/**
 * Smart Conflict Prediction — live UI surface.
 *
 * Watches the active editor: when the open file is tracked AND another
 * machine has marked itself as currently editing the same file (via the
 * existing per-file `editingBy` / `editingByName` fields populated by the
 * soft-lock pipeline), surfaces a status-bar warning.
 *
 * Pure scoring + activeOthers extraction live in
 * `core/smartConflictPrediction.ts`.
 *
 * Limitations:
 *  - Only sees `editingBy` records that the existing soft-lock pipeline
 *    already propagated through the cloud manifest. The "presence wire"
 *    full path (per-path editingBy in _machines.json with sub-second
 *    heartbeat) remains future work.
 *  - Detection is best-effort, scoped to the active editor; we don't
 *    walk every open editor on every keystroke.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { GlobalConfigManager } from "../core/globalConfigManager.js";
import {
  scoreConflictRisk,
  type OtherMachineEdit,
} from "../core/smartConflictPrediction.js";

const REFRESH_INTERVAL_MS = 30_000;

export class SmartConflictPredictionService implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly globalConfig: GlobalConfigManager) {
    this.statusBar = vscode.window.createStatusBarItem(
      "vscodesync.smartConflictPrediction",
      vscode.StatusBarAlignment.Left,
      90,
    );
    this.statusBar.name = "VSCodeSync · Conflict prediction";
  }

  start(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => { void this.refresh(); }),
      vscode.workspace.onDidSaveTextDocument(() => { void this.refresh(); }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("vscodesync.smartConflictPrediction")) {
          void this.refresh();
        }
      }),
    );
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_INTERVAL_MS);
    void this.refresh();
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.statusBar.dispose();
  }

  private async refresh(): Promise<void> {
    const enabled = vscode.workspace
      .getConfiguration("vscodesync")
      .get<boolean>("smartConflictPrediction.enabled", true);
    if (!enabled) {
      this.statusBar.hide();
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== "file") {
      this.statusBar.hide();
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder) {
      this.statusBar.hide();
      return;
    }
    const rel = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) {
      this.statusBar.hide();
      return;
    }
    const wc = await WorkspaceConfigManager.load(folder.uri.fsPath).catch(() => null);
    if (!wc) {
      this.statusBar.hide();
      return;
    }
    const myMachineName = await this.resolveMachineName();
    const others: OtherMachineEdit[] = wc.files
      .filter(
        (f) =>
          f.localPath === rel &&
          (f.editingBy ?? "") !== "" &&
          (f.editingByName ?? f.editingBy) !== myMachineName,
      )
      .map((f) => ({
        machineName: f.editingByName ?? f.editingBy ?? "",
        relPath: f.localPath,
        startedAtMs: 0,
        // We don't track lastSeenMs locally; treat presence as fresh — the
        // soft-lock pipeline already prunes stale entries via TTL.
        lastSeenMs: Date.now(),
      }));
    const result = scoreConflictRisk({
      myMachineName,
      myEditingPath: rel,
      others,
      nowMs: Date.now(),
    });
    if (result.score === 0) {
      this.statusBar.hide();
      return;
    }
    const who = result.activeOthers.join(", ");
    this.statusBar.text = `$(warning) Conflict risk: ${who} editing this file`;
    this.statusBar.tooltip = new vscode.MarkdownString(
      `**VSCodeSync** · риск конфликта ${(result.score * 100).toFixed(0)}%.\n\n` +
        `Параллельная работа на: ${who}.\n\n` +
        `Сохраните и сделайте Push раньше них, либо подождите их sync.`,
    );
    this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.statusBar.show();
  }

  private async resolveMachineName(): Promise<string> {
    try {
      const cfg = await this.globalConfig.load();
      return cfg.machineName;
    } catch {
      return "";
    }
  }
}
