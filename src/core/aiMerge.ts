/**
 * AI-assisted 3-way merge using VS Code Language Model API (Copilot / any LM).
 * Requires vscodesync.aiMerge: true and a compatible LM available in VS Code.
 *
 * The merge prompt sends base / local / remote versions and asks the model
 * to produce a merged result. If the model cannot resolve the conflict it returns null.
 */
import * as vscode from "vscode";

const CFG = "vscodesync";
const MAX_CONTENT_CHARS = 12_000; // per section; ~3K tokens each

export type AiMergeResult =
  | { ok: true; merged: string }
  | { ok: false; reason: "disabled" | "no_model" | "too_large" | "model_refused" | "error"; detail?: string };

// Minimal typed surface for vscode.lm (older @types/vscode bundled with the
// engine version in package.json may not declare it; the runtime exposes the
// API on supported versions).
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
  if (v.lm && v.LanguageModelChatMessage) {
    return { api: v.lm, ChatMessage: v.LanguageModelChatMessage };
  }
  return null;
}

/**
 * Attempt AI merge of a 3-way conflict.
 *
 * @param base   - Common ancestor (e.g. last version from `.history/`).
 * @param local  - Local (mine) version.
 * @param remote - Cloud (theirs) version.
 * @param relPath - Relative file path (for context in the prompt).
 */
export async function runAiMerge(
  base: string,
  local: string,
  remote: string,
  relPath: string,
): Promise<AiMergeResult> {
  const cfg = vscode.workspace.getConfiguration(CFG);
  if (!cfg.get<boolean>("aiMerge", false)) {
    return { ok: false, reason: "disabled" };
  }

  // Check content size to avoid exceeding context windows
  if (
    base.length > MAX_CONTENT_CHARS ||
    local.length > MAX_CONTENT_CHARS ||
    remote.length > MAX_CONTENT_CHARS
  ) {
    return {
      ok: false,
      reason: "too_large",
      detail: `Файл слишком большой для AI merge (>${String(MAX_CONTENT_CHARS)} символов на секцию)`,
    };
  }

  const lm = getLm();
  if (!lm) {
    return { ok: false, reason: "no_model", detail: "vscode.lm API недоступен в этой версии VS Code" };
  }

  // Select LM — prefer gpt-4o class, fall back to any available
  let model: LmChatModel;
  try {
    const preferred = await lm.api.selectChatModels({ vendor: "copilot", family: "gpt-4o" });
    const list = preferred.length > 0 ? preferred : await lm.api.selectChatModels();
    if (list.length === 0) {
      return {
        ok: false,
        reason: "no_model",
        detail: "Нет доступной языковой модели (Copilot не активирован?)",
      };
    }
    model = list[0];
  } catch {
    return { ok: false, reason: "no_model", detail: "vscode.lm API недоступен" };
  }

  const prompt = buildMergePrompt(base, local, remote, relPath);
  const cts = new vscode.CancellationTokenSource();
  const messages = [lm.ChatMessage.User(prompt)];

  let responseText = "";
  try {
    const response = await model.sendRequest(messages, {}, cts.token);
    for await (const chunk of response.text) {
      responseText += chunk;
    }
  } catch (e: unknown) {
    return { ok: false, reason: "error", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    cts.dispose();
  }

  const merged = extractMergedContent(responseText);
  if (merged === null) {
    return {
      ok: false,
      reason: "model_refused",
      detail: "Модель не смогла разрешить конфликт. Разрешите вручную.",
    };
  }
  return { ok: true, merged };
}

function buildMergePrompt(base: string, local: string, remote: string, relPath: string): string {
  return `You are a code merge assistant. Perform a 3-way merge for the file \`${relPath}\`.

Rules:
- Produce ONLY the final merged file content, wrapped between \`<merged>\` and \`</merged>\` tags.
- If the conflict is irresolvable (genuine semantic conflict), reply with exactly: <merged>CONFLICT</merged>
- Do NOT add explanations outside the tags.
- Preserve all non-conflicting changes from both LOCAL and REMOTE.
- Resolve conflicts by applying both changes where possible; prefer LOCAL for style/formatting.

<base>
${base}
</base>

<local>
${local}
</local>

<remote>
${remote}
</remote>`;
}

function extractMergedContent(response: string): string | null {
  const match = /<merged>([\s\S]*?)<\/merged>/.exec(response);
  if (!match) return null;
  const content = match[1];
  if (content.trim() === "CONFLICT") return null;
  return content;
}

/**
 * Check whether AI merge is available (enabled + LM accessible).
 * Used to conditionally show the "Merge with AI" button in conflict UI.
 */
export async function isAiMergeAvailable(): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration(CFG);
  if (!cfg.get<boolean>("aiMerge", false)) {
    return false;
  }
  const lm = getLm();
  if (!lm) return false;
  try {
    const models = await lm.api.selectChatModels();
    return models.length > 0;
  } catch {
    return false;
  }
}
