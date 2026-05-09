/**
 * v2.20.5 — workspace templates marketplace install command.
 *
 * Fetches a git-hosted index (default: a public raw GitHub URL configurable
 * via `vscodesync.templates.registryUrl`), lists templates, and applies the
 * picked one to the open workspace folder:
 *   - writes `.vscodesync-template.json` (provenance).
 *   - merges `ignorePatterns` into the workspace's `.vscodesync-ignore`.
 *   - shows the `welcomeMarkdown` in a webview if present.
 *   - opens recommended extensions via `workbench.extensions.installExtension`.
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  parseWorkspaceTemplate,
  type WorkspaceTemplateManifest,
} from "../core/workspaceTemplate.js";

const COMMAND_ID = "vscodesync.installWorkspaceTemplateFromMarketplace";
const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/borodatych/vscodesync-templates/main/index.json";

interface RegistryIndexEntry {
  manifestUrl: string;
}

export function registerTemplateMarketplace(): vscode.Disposable[] {
  return [vscode.commands.registerCommand(COMMAND_ID, runInstallFromMarketplace)];
}

async function runInstallFromMarketplace(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("vscodesync");
  const registryUrl = cfg.get<string>("templates.registryUrl", "").trim() || DEFAULT_REGISTRY_URL;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
    return;
  }

  let entries: RegistryIndexEntry[];
  try {
    const res = await fetch(registryUrl);
    if (!res.ok) {
      await vscode.window.showWarningMessage(`VSCodeSync: registry returned ${String(res.status)}.`);
      return;
    }
    const json = (await res.json()) as { templates?: unknown };
    if (!Array.isArray(json.templates)) {
      await vscode.window.showWarningMessage("VSCodeSync: registry index missing `templates[]`.");
      return;
    }
    entries = json.templates
      .filter((e): e is RegistryIndexEntry => typeof e === "object" && e !== null && typeof (e as RegistryIndexEntry).manifestUrl === "string");
  } catch (e) {
    await vscode.window.showWarningMessage(
      `VSCodeSync: registry fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  if (entries.length === 0) {
    await vscode.window.showInformationMessage("VSCodeSync: registry пуст.");
    return;
  }

  // Fetch every manifest concurrently, drop malformed.
  const manifests: WorkspaceTemplateManifest[] = [];
  await Promise.all(entries.map(async (e) => {
    try {
      const res = await fetch(e.manifestUrl);
      if (!res.ok) return;
      const raw: unknown = await res.json();
      const parsed = parseWorkspaceTemplate(raw);
      if (parsed.ok) manifests.push(parsed.manifest);
    } catch { /* swallow per-template errors */ }
  }));

  if (manifests.length === 0) {
    await vscode.window.showWarningMessage("VSCodeSync: ни один template manifest не прошёл валидацию.");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    manifests.map((m) => ({
      label: m.name,
      description: m.id + (m.version ? ` v${m.version}` : ""),
      detail: m.description,
      manifest: m,
    })),
    { placeHolder: "Выберите workspace template" },
  );
  if (!picked) return;

  await applyTemplate(folder.uri.fsPath, picked.manifest);
}

async function applyTemplate(rootAbs: string, manifest: WorkspaceTemplateManifest): Promise<void> {
  // 1. Provenance file.
  const provenancePath = path.join(rootAbs, ".vscodesync-template.json");
  await fs.writeFile(provenancePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // 2. Merge ignore patterns into existing .vscodesync-ignore.
  const ignorePath = path.join(rootAbs, ".vscodesync-ignore");
  let existing = "";
  try { existing = await fs.readFile(ignorePath, "utf8"); } catch { /* file may not exist */ }
  const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const additions = manifest.ignorePatterns.filter((p) => !existingLines.has(p));
  if (additions.length > 0) {
    const merged = existing + (existing.endsWith("\n") || existing.length === 0 ? "" : "\n")
      + `# vscodesync template: ${manifest.id}\n` + additions.join("\n") + "\n";
    await fs.writeFile(ignorePath, merged, "utf8");
  }

  // 3. Welcome markdown — render in webview when present.
  if (manifest.welcomeMarkdown !== undefined && manifest.welcomeMarkdown.length > 0) {
    const panel = vscode.window.createWebviewPanel(
      "vscodesync.templateWelcome",
      `Template: ${manifest.name}`,
      vscode.ViewColumn.Active,
      { enableScripts: false },
    );
    panel.webview.html = `<!DOCTYPE html><meta charset="utf-8"><body style="font-family:system-ui;padding:32px;"><pre style="white-space:pre-wrap;">${escapeHtml(manifest.welcomeMarkdown)}</pre></body>`;
  }

  // 4. Recommend extensions — open the marketplace search for each.
  if (manifest.recommendedExtensions.length > 0) {
    const choice = await vscode.window.showInformationMessage(
      `VSCodeSync: установить ${String(manifest.recommendedExtensions.length)} рекомендованных расширений?`,
      "Установить", "Пропустить",
    );
    if (choice === "Установить") {
      for (const ext of manifest.recommendedExtensions) {
        await vscode.commands.executeCommand("workbench.extensions.installExtension", ext);
      }
    }
  }

  await vscode.window.showInformationMessage(
    `VSCodeSync: template '${manifest.name}' применён (${String(manifest.defaultFilesGlob.length)} glob, ${String(manifest.ignorePatterns.length)} ignore).`,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
