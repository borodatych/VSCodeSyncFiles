/**
 * SARIF conflict export command (v2.20.5).
 *
 * `vscodesync.exportConflictsToSarif` reads the conflict heatmap log,
 * serialises it to SARIF v2.1.0 via {@link buildConflictSarif}, and writes
 * the resulting JSON to a user-chosen `.sarif` file. Suitable for ingestion
 * by GitHub Code Scanning, SonarQube, or any other SARIF-aware analysis
 * pipeline.
 *
 * No I/O happens until the user picks a destination — the command is
 * destination-only-on-confirm so accidental palette taps don't write files.
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { buildConflictSarif } from "../core/conflictHeatmapSarif.js";
import { loadConflictLog } from "../ui/conflictHeatmapStoreFs.js";

const COMMAND = "vscodesync.exportConflictsToSarif";

export interface SarifExportDeps {
  storageDir: string;
}

export function registerSarifExportCommand(deps: SarifExportDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(COMMAND, () => runExport(deps.storageDir)),
  ];
}

async function runExport(storageDir: string): Promise<void> {
  const log = await loadConflictLog(storageDir);
  if (log.entries.length === 0) {
    void vscode.window.showInformationMessage(
      "VSCodeSync: heatmap пустой — нечего экспортировать в SARIF.",
    );
    return;
  }

  const defaultUri = pickDefaultDestination();
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { SARIF: ["sarif", "json"] },
    title: "Сохранить SARIF отчёт VSCodeSync",
    saveLabel: "Сохранить",
  });
  if (!target) return;

  const sarif = buildConflictSarif(log, { deduplicate: true });
  try {
    await fs.writeFile(target.fsPath, `${JSON.stringify(sarif, null, 2)}\n`, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await vscode.window.showErrorMessage(`VSCodeSync: SARIF write failed — ${msg}`);
    return;
  }

  const reveal = await vscode.window.showInformationMessage(
    `VSCodeSync: SARIF report записан в ${target.fsPath}.`,
    "Открыть",
  );
  if (reveal === "Открыть") {
    await vscode.commands.executeCommand("vscode.open", target);
  }
}

function pickDefaultDestination(): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return undefined;
  return vscode.Uri.joinPath(folders[0].uri, "vscodesync-conflicts.sarif");
}
