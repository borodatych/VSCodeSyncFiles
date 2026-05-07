import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";

const GITIGNORE_ENTRY = ".vscode/vscodesync.json";
const WILDCARD_PATTERNS = [".vscode/vscodesync.json", ".vscode/*.json", "**/.vscode/vscodesync.json", ".vscode/"];

/** Проверяет, покрывает ли существующий .gitignore наш путь (упрощённо). */
export function gitignoreCoversVscodesync(content: string): boolean {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) {
      continue;
    }
    const rule = t.replace(/^!+/, "");
    for (const p of WILDCARD_PATTERNS) {
      if (rule === p || rule === GITIGNORE_ENTRY) {
        return true;
      }
      if (p.includes("*") && GITIGNORE_ENTRY.startsWith(rule.replace("*", ""))) {
        return true;
      }
    }
    if (rule === ".vscode/" || rule.endsWith("/.vscode/")) {
      return true;
    }
  }
  return false;
}

export function buildGitignoreAppend(existing: string | undefined): string {
  const base = existing?.replace(/\s*$/, "") ?? "";
  const sep = base.length > 0 && !base.endsWith("\n") ? "\n" : "";
  return `${base}${sep}\n# VSCodeSync local cache (not source of truth)\n${GITIGNORE_ENTRY}\n`;
}

export async function ensureWorkspaceGitignoreEntry(
  workspaceFolder: vscode.Uri | undefined,
  showInformationMessage?: typeof vscode.window.showInformationMessage,
): Promise<void> {
  if (!workspaceFolder) {
    return;
  }
  const root = workspaceFolder.fsPath;
  const gitignorePath = path.join(root, ".gitignore");
  let existing: string | undefined;
  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      const create = showInformationMessage
        ? await showInformationMessage(
            "VSCodeSync: нет .gitignore. Создать с записью для кэша vscodesync?",
            "Создать",
            "Позже",
          )
        : "Создать";
      if (create !== "Создать") {
        return;
      }
      await fs.writeFile(gitignorePath, buildGitignoreAppend(undefined), "utf8");
      await showInformationMessage?.(".gitignore создан, добавлен .vscode/vscodesync.json");
      return;
    }
    throw e;
  }
  if (gitignoreCoversVscodesync(existing)) {
    return;
  }
  const append = buildGitignoreAppend(existing);
  await fs.writeFile(gitignorePath, append, "utf8");
  await showInformationMessage?.(
    "VSCodeSync: в .gitignore добавлен .vscode/vscodesync.json (локальный кэш).",
  );
}
