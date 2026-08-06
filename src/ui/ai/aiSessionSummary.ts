/**
 * AI Sync Session Summary — turns the recent Activity Feed into a short
 * human-readable narrative ("today you pushed auth fixes from work, pulled DB
 * migrations from home, …"). Reuses the same `vscode.lm` API as `aiMerge.ts`.
 *
 * Pure function: takes the events, returns a string. UI / command wiring lives
 * in `extension.ts`.
 */
import * as vscode from "vscode";
import type { ActivityEvent } from "../../core/activityLog.js";

const MAX_EVENTS = 200;

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

export type SessionSummaryResult =
  | { ok: true; summary: string }
  | { ok: false; reason: "no_model" | "no_events" | "error"; detail?: string };

export async function summariseActivity(
  events: readonly ActivityEvent[],
  windowLabel: string,
  cancellationToken?: vscode.CancellationToken,
): Promise<SessionSummaryResult> {
  if (events.length === 0) {
    return { ok: false, reason: "no_events" };
  }
  const lm = getLm();
  if (!lm) {
    return { ok: false, reason: "no_model", detail: "vscode.lm API недоступен" };
  }

  let model: LmChatModel;
  try {
    const preferred = await lm.api.selectChatModels({ vendor: "copilot", family: "gpt-4o" });
    const list = preferred.length > 0 ? preferred : await lm.api.selectChatModels();
    if (list.length === 0) return { ok: false, reason: "no_model" };
    model = list[0];
  } catch {
    return { ok: false, reason: "no_model" };
  }

  const recent = events.slice(-MAX_EVENTS);
  const lines = recent.map((e) => {
    const t = e.at.replace("T", " ").slice(0, 19);
    const machine = e.machineName ? `[${e.machineName}]` : "";
    const ws = e.workspaceNote ? `«${e.workspaceNote}»` : e.workspaceId.slice(0, 8);
    return `${t} ${machine} ${e.kind} ${ws} ${e.relPath}`;
  });

  const prompt = `You are a sync activity summariser. Below is the user's recent VSCodeSync activity log.

Window: ${windowLabel}

Activity log (oldest first, one event per line):
${lines.join("\n")}

Produce a short bullet-list summary in Russian (2–6 bullets) of what the user did with their files in this window. Emphasise:
- What they pushed (created/edited) — only mention file types or workspaces, never raw paths.
- What they pulled — same.
- Any conflicts that surfaced and whether they were resolved.
- Switches between machines (only if there were several).

Format: each bullet starts with "• ". No headers, no preamble, no closing remarks. Just bullets.`;

  const cts = cancellationToken ? null : new vscode.CancellationTokenSource();
  const token = cancellationToken ?? cts!.token;
  let response = "";
  try {
    const reply = await model.sendRequest([lm.ChatMessage.User(prompt)], {}, token);
    for await (const chunk of reply.text) {
      response += chunk;
    }
  } catch (e: unknown) {
    return { ok: false, reason: "error", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    cts?.dispose();
  }

  const cleaned = response.trim();
  if (cleaned.length === 0) {
    return { ok: false, reason: "error", detail: "пустой ответ модели" };
  }
  return { ok: true, summary: cleaned };
}

export async function suggestWorkspaceTags(
  files: readonly string[],
  cancellationToken?: vscode.CancellationToken,
): Promise<{ ok: true; tags: string[] } | { ok: false }> {
  if (files.length === 0) return { ok: false };
  const lm = getLm();
  if (!lm) return { ok: false };
  let model: LmChatModel;
  try {
    const preferred = await lm.api.selectChatModels({ vendor: "copilot", family: "gpt-4o" });
    const list = preferred.length > 0 ? preferred : await lm.api.selectChatModels();
    if (list.length === 0) return { ok: false };
    model = list[0];
  } catch {
    return { ok: false };
  }

  const previewFiles = files.slice(0, 30).map((p) => `- ${p}`);
  const prompt = `Suggest 2 to 4 short lowercase tags (single English words, no spaces) for a development workspace with these files:

${previewFiles.join("\n")}

Output ONLY a comma-separated list of tags (no preamble, no quotes). Examples of good tags: auth, frontend, migration, testing, infra, docs.`;

  const cts = cancellationToken ? null : new vscode.CancellationTokenSource();
  const token = cancellationToken ?? cts!.token;
  let response = "";
  try {
    const reply = await model.sendRequest([lm.ChatMessage.User(prompt)], {}, token);
    for await (const chunk of reply.text) {
      response += chunk;
    }
  } catch {
    return { ok: false };
  } finally {
    cts?.dispose();
  }

  const tags = response
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z][a-z0-9-]{1,20}$/.test(s));
  if (tags.length === 0) return { ok: false };
  return { ok: true, tags: [...new Set(tags)].slice(0, 4) };
}
