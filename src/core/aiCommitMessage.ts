/**
 * AI commit-message suggestions for snapshot creation and quick-transfer
 * notes. Reuses the same `vscode.lm` Copilot/LM bridge pattern as
 * `aiSessionSummary.ts` — minimal typed surface, lazy-load, fail-soft.
 *
 * Typical use: pre-fill the InputBox for `vscodesync.createSnapshot` /
 * `vscodesync.sendQuickTransfer` so users with empty mental state still
 * land on a meaningful note ("fix: env loader race + 2 ts типа").
 *
 * Pure prompt construction lives in `aiCommitPrompt.ts` and is unit-tested
 * separately.
 */
import * as vscode from "vscode";
import { buildCommitPrompt, type CommitContext } from "./aiCommitPrompt.js";

export type { CommitContext } from "./aiCommitPrompt.js";
export { buildCommitPrompt } from "./aiCommitPrompt.js";

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

export type CommitSuggestion =
  | { ok: true; message: string }
  | { ok: false; reason: "no_model" | "empty" | "too_long"; detail?: string };

export async function suggestCommitMessage(
  ctx: CommitContext,
): Promise<CommitSuggestion> {
  if (ctx.changedFiles.length === 0) {
    return { ok: false, reason: "empty" };
  }
  const lm = getLm();
  if (!lm) return { ok: false, reason: "no_model" };

  let model: LmChatModel;
  try {
    const preferred = await lm.api.selectChatModels({ vendor: "copilot", family: "gpt-4o-mini" });
    const list = preferred.length > 0 ? preferred : await lm.api.selectChatModels();
    if (list.length === 0) return { ok: false, reason: "no_model" };
    model = list[0];
  } catch {
    return { ok: false, reason: "no_model" };
  }

  const cts = new vscode.CancellationTokenSource();
  let response = "";
  try {
    const reply = await model.sendRequest(
      [lm.ChatMessage.User(buildCommitPrompt(ctx))],
      {},
      cts.token,
    );
    for await (const chunk of reply.text) {
      response += chunk;
    }
  } catch {
    return { ok: false, reason: "no_model" };
  } finally {
    cts.dispose();
  }

  const cleaned = response.trim().split("\n")[0]?.trim() ?? "";
  if (cleaned.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (cleaned.length > 200) {
    return { ok: false, reason: "too_long", detail: cleaned.slice(0, 80) };
  }
  return { ok: true, message: cleaned };
}
