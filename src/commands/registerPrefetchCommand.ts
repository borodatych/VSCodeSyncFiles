/**
 * v2.20.2 — `vscodesync.prefetchActiveWorkspace` command wiring.
 *
 * Picks recently-touched files from the workspace's tracked file list,
 * runs them through `planPrefetchHints`, and forwards the chosen URIs to
 * `vscode.workspace.fs.prefetch` via the defensive adapter
 * (`tryPrefetchUris`). When the proposed API isn't on the host surface,
 * the user gets a single info-toast explaining why nothing happened.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { planPrefetchHints, type PrefetchCandidate } from "../core/workspaceFsPrefetchHints.js";
import { tryPrefetchUris } from "../ui/workspaceFsPrefetchAdapter.js";

const COMMAND_ID = "vscodesync.prefetchActiveWorkspace";

export function registerPrefetchCommand(): vscode.Disposable[] {
  return [vscode.commands.registerCommand(COMMAND_ID, runPrefetch)];
}

async function runPrefetch(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
    return;
  }
  const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
  if (wc.activeWorkspaces.length === 0) {
    await vscode.window.showInformationMessage(
      "VSCodeSync: нет подключённых workspace в этой папке.",
    );
    return;
  }
  // WorkspaceConfig.files lives on the WorkspaceConfig level, not per-workspace.
  // Each TrackedFile carries its workspaceId; iterate the flat list.
  const candidates: PrefetchCandidate[] = wc.files.map((file) => {
    const relPath = path.relative(folder.uri.fsPath, file.localPath).replace(/\\/g, "/");
    const lastSyncMs = Date.parse(file.lastSync);
    return {
      relPath,
      modifiedMs: Number.isFinite(lastSyncMs) ? lastSyncMs : undefined,
    };
  });
  const plan = planPrefetchHints({ candidates });
  if (plan.toPrefetch.length === 0) {
    await vscode.window.showInformationMessage(
      "VSCodeSync: prefetch — нет кандидатов (recent threshold не пройден).",
    );
    return;
  }
  const uris = plan.toPrefetch.map((rel) =>
    vscode.Uri.file(path.join(folder.uri.fsPath, rel)),
  );
  // The proposed API lives on `vscode.workspace.fs`. Cast through `unknown`
  // because @types/vscode for stable doesn't expose `prefetch`.
  const surface = {
    fs: vscode.workspace.fs as unknown as { prefetch?: (u: vscode.Uri) => Promise<void> },
  };
  const result = await tryPrefetchUris(surface, { uris });
  if (result.ok) {
    await vscode.window.showInformationMessage(
      `VSCodeSync: prefetch — прогрето ${String(result.prefetched)} файлов.`,
    );
    return;
  }
  switch (result.reason) {
    case "api_not_available":
      await vscode.window.showInformationMessage(
        "VSCodeSync: workspace.fs.prefetch недоступен в этой версии VS Code (proposed API). Включите --enable-proposed-api или обновитесь.",
      );
      return;
    case "no_uris":
      await vscode.window.showInformationMessage("VSCodeSync: нет файлов для prefetch.");
      return;
    case "error":
      await vscode.window.showWarningMessage(
        `VSCodeSync: prefetch failed — ${result.detail ?? "unknown error"}`,
      );
      return;
  }
}
