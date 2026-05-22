/**
 * Install-template command — picks a template from the built-in catalog,
 * asks the user for a target folder, plans the file writes via the pure
 * helper, and writes them through `writeTextFileAtomic`.
 *
 * Skips overwrite of existing files unless the user confirms; on conflict
 * with even one file we offer "Overwrite all" / "Skip existing" / "Cancel".
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeTextFileAtomic } from "../core/writeTextFileAtomic.js";
import {
  BUILT_IN_TEMPLATES,
  planTemplateInstall,
  type WorkspaceTemplate,
} from "../core/workspaceTemplates.js";

export async function runInstallWorkspaceTemplate(): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    BUILT_IN_TEMPLATES.map((t) => ({
      label: t.title,
      description: t.tags.join(" · "),
      detail: t.description,
      template: t,
    })),
    { title: "VSCodeSync — install workspace template", placeHolder: "Выберите шаблон" },
  );
  if (!pick) return;
  const template: WorkspaceTemplate = pick.template;

  const folderUris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: `Создать «${template.title}» здесь`,
  });
  if (!folderUris || folderUris.length === 0) return;
  const targetFolder = folderUris[0]?.fsPath ?? "";
  if (!targetFolder) return;

  const plan = planTemplateInstall(template, targetFolder.replace(/\\/g, "/"));

  // Probe for collisions BEFORE we touch anything on disk.
  const existing: string[] = [];
  for (const entry of plan) {
    const real = entry.absolutePath.replace(/\//g, path.sep);
    try {
      await fs.access(real);
      existing.push(entry.relPath);
    } catch {
      /* not present — good */
    }
  }
  let overwrite = false;
  if (existing.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `Уже существуют ${String(existing.length)} файл(ов): ${existing.slice(0, 3).join(", ")}${existing.length > 3 ? "…" : ""}`,
      { modal: true },
      "Перезаписать",
      "Пропустить существующие",
    );
    if (!choice) return;
    overwrite = choice === "Перезаписать";
  }

  const written: string[] = [];
  const skipped: string[] = [];
  for (const entry of plan) {
    const real = entry.absolutePath.replace(/\//g, path.sep);
    if (existing.includes(entry.relPath) && !overwrite) {
      skipped.push(entry.relPath);
      continue;
    }
    try {
      await fs.mkdir(path.dirname(real), { recursive: true });
      await writeTextFileAtomic(real, entry.content);
      written.push(entry.relPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await vscode.window.showErrorMessage(`VSCodeSync: не удалось записать ${entry.relPath}: ${msg}`);
      return;
    }
  }
  const summary =
    skipped.length === 0
      ? `Создано ${String(written.length)} файл(ов).`
      : `Создано ${String(written.length)}, пропущено ${String(skipped.length)} существующих.`;
  void vscode.window.showInformationMessage(`VSCodeSync · template «${template.title}» — ${summary}`);
}
