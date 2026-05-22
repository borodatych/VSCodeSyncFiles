/**
 * Command flow for the AI Path Mapper.
 *
 * 1. Asks user for the *old* workspace root (one input box).
 * 2. Loads candidate config files from the current workspace.
 * 3. Builds prompt + calls `vscode.lm` for a remap.
 * 4. Shows the suggested edits in a Diff editor; user approves.
 *
 * The pure analysis lives in `src/core/aiPathMapper.ts` (vscode-free, tested).
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  applyRemapEdits,
  buildPathMapperPrompt,
  findSuspiciousPaths,
  parseRemapEdits,
} from "../core/aiPathMapper.js";

interface LmChatModel {
  sendRequest(
    messages: unknown[],
    options: Record<string, unknown>,
    token: vscode.CancellationToken,
  ): Promise<{ text: AsyncIterable<string> }>;
}
interface LmApi {
  selectChatModels(filter?: { vendor?: string; family?: string }): Promise<LmChatModel[]>;
}
interface LmChatMessageStatic {
  User(text: string): unknown;
}
interface VscodeWithLm {
  readonly lm?: LmApi;
  readonly LanguageModelChatMessage?: LmChatMessageStatic;
}
function getLm(): { api: LmApi; ChatMessage: LmChatMessageStatic } | null {
  const v = vscode as unknown as VscodeWithLm;
  if (v.lm && v.LanguageModelChatMessage) return { api: v.lm, ChatMessage: v.LanguageModelChatMessage };
  return null;
}

const CANDIDATE_FILES = [
  ".vscode/launch.json",
  ".vscode/tasks.json",
  ".vscode/settings.json",
  ".env",
  ".env.local",
];

export async function runAiPathMapper(cancellationToken?: vscode.CancellationToken): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
    return;
  }
  const newRoot = folders[0]?.uri.fsPath ?? "";
  if (!newRoot) return;
  const oldRoot = await vscode.window.showInputBox({
    prompt: "Старый workspace root (с другой машины)",
    placeHolder: "/home/alice/Projects/myapp или D:\\Old\\Projects\\myapp",
  });
  if (!oldRoot) return;

  const configs: Record<string, string> = {};
  for (const rel of CANDIDATE_FILES) {
    const abs = path.join(newRoot, rel);
    try {
      const buf = await fs.readFile(abs, "utf8");
      configs[rel] = buf;
    } catch {
      /* file may not exist; skip silently */
    }
  }
  if (Object.keys(configs).length === 0) {
    void vscode.window.showInformationMessage("VSCodeSync: не найдено конфиг-файлов для анализа.");
    return;
  }

  const suspicious = findSuspiciousPaths({ oldRoot, newRoot, configs });
  if (suspicious.length === 0) {
    void vscode.window.showInformationMessage("VSCodeSync: подозрительных абсолютных путей не найдено.");
    return;
  }

  const lm = getLm();
  if (!lm) {
    await vscode.window.showWarningMessage(
      `VSCodeSync: vscode.lm недоступен. Найдено ${String(suspicious.length)} подозрительных путей — отредактируйте вручную.`,
    );
    return;
  }

  const prompt = buildPathMapperPrompt({ oldRoot, newRoot, configs }, suspicious);
  let model: LmChatModel;
  try {
    const preferred = await lm.api.selectChatModels({ vendor: "copilot", family: "gpt-4o-mini" });
    const list = preferred.length > 0 ? preferred : await lm.api.selectChatModels();
    if (list.length === 0) {
      await vscode.window.showWarningMessage("VSCodeSync: подходящая LM-модель не найдена.");
      return;
    }
    model = list[0];
  } catch {
    await vscode.window.showWarningMessage("VSCodeSync: vscode.lm недоступен.");
    return;
  }

  const cts = cancellationToken ? null : new vscode.CancellationTokenSource();
  const token = cancellationToken ?? cts!.token;
  let response = "";
  try {
    const reply = await model.sendRequest([lm.ChatMessage.User(prompt)], {}, token);
    for await (const chunk of reply.text) response += chunk;
  } catch (e) {
    await vscode.window.showErrorMessage(
      `VSCodeSync: AI Path Mapper failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  } finally {
    cts?.dispose();
  }

  const edits = parseRemapEdits(response);
  if (edits.length === 0) {
    void vscode.window.showInformationMessage("VSCodeSync: AI не вернул валидных правок.");
    return;
  }
  // Apply per-file and present a confirmation prompt before writing.
  const byFile = new Map<string, typeof edits>();
  for (const e of edits) {
    const list = byFile.get(e.configPath) ?? [];
    list.push(e);
    byFile.set(e.configPath, list);
  }
  const files = [...byFile.keys()].join(", ");
  const choice = await vscode.window.showInformationMessage(
    `VSCodeSync: AI предложил ${String(edits.length)} правок в ${files}. Применить?`,
    "Применить",
    "Отмена",
  );
  if (choice !== "Применить") return;
  for (const [rel, list] of byFile) {
    const abs = path.join(newRoot, rel);
    const cur = configs[rel] ?? "";
    if (cur === "") continue;
    const next = applyRemapEdits(cur, list);
    if (next !== cur) {
      try {
        await fs.writeFile(abs, next, "utf8");
      } catch (e) {
        await vscode.window.showErrorMessage(
          `VSCodeSync: не удалось записать ${rel}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  void vscode.window.showInformationMessage(`VSCodeSync: применено ${String(edits.length)} правок.`);
}

/**
 * One-shot prompt offered the first time a given cloud workspace is attached
 * on this machine: "run AI Path Mapper to fix old absolute paths in your
 * configs?". Idempotent — the answer is recorded in globalState so the prompt
 * is shown at most once per (machine × workspaceId).
 */
export async function maybePromptPathMapperAfterAttach(
  context: vscode.ExtensionContext,
  workspaceId: string,
): Promise<void> {
  const key = `vscodesync.aiPathMapper.promptedFor:${workspaceId}`;
  if (context.globalState.get<boolean>(key)) return;
  await context.globalState.update(key, true);

  const lm = (vscode as unknown as VscodeWithLm).lm;
  if (!lm) return;

  const choice = await vscode.window.showInformationMessage(
    "VSCodeSync: workspace подключён. Проверить абсолютные пути в .vscode/launch.json и др. через AI Path Mapper?",
    "Запустить",
    "Не сейчас",
  );
  if (choice === "Запустить") {
    await vscode.commands.executeCommand("vscodesync.aiPathMapper");
  }
}
