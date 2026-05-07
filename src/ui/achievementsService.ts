/**
 * Achievements UI service.
 *
 * On activate (after a 5 s warmup so we don't pile onto extension startup)
 * we read the activity log, evaluate which achievements have been unlocked,
 * diff against the persisted set in `globalState`, pop a one-shot
 * notification per newly-crossed milestone, and persist the new ids.
 *
 * Also exposes:
 *  - `runEvaluateAndPopup(context, storageDir)` — same flow, callable from
 *    a manual command.
 *  - `runShowAchievements(context, storageDir)` — list all known
 *    achievements + lock state in OutputChannel.
 *
 * Pure helpers `evaluateAchievements` / `newlyUnlocked` live in
 * `core/achievements.ts` and are unit-tested.
 */
import * as vscode from "vscode";
import { loadActivityFile } from "../core/activityLog.js";
import {
  evaluateAchievements,
  newlyUnlocked,
  type Achievement,
} from "../core/achievements.js";

const STATE_KEY = "vscodesync.achievements.unlockedIds";

function loadUnlockedIds(context: vscode.ExtensionContext): Set<string> {
  const raw = context.globalState.get<string[]>(STATE_KEY);
  return new Set(raw ?? []);
}

async function saveUnlockedIds(
  context: vscode.ExtensionContext,
  ids: ReadonlySet<string>,
): Promise<void> {
  await context.globalState.update(STATE_KEY, [...ids]);
}

export async function runEvaluateAndPopup(
  context: vscode.ExtensionContext,
  storageDir: string,
): Promise<Achievement[]> {
  const file = await loadActivityFile(storageDir).catch(() => ({ schema: 1 as const, events: [] }));
  const evaluated = evaluateAchievements(file.events);
  const known = loadUnlockedIds(context);
  const fresh = newlyUnlocked(evaluated, known);
  if (fresh.length === 0) return [];
  for (const id of fresh.map((a) => a.id)) known.add(id);
  await saveUnlockedIds(context, known);
  // Pop one notification per achievement so the user sees them all even if
  // multiple unlock at once. Fire-and-forget — we don't await the await
  // queue so the activate path doesn't block.
  for (const a of fresh) {
    void vscode.window.showInformationMessage(`🏆 Achievement unlocked — ${a.title} · ${a.description}`);
  }
  return fresh;
}

export async function runShowAchievements(
  context: vscode.ExtensionContext,
  storageDir: string,
): Promise<void> {
  const file = await loadActivityFile(storageDir).catch(() => ({ schema: 1 as const, events: [] }));
  const evaluated = evaluateAchievements(file.events);
  const known = loadUnlockedIds(context);
  const channel = vscode.window.createOutputChannel("VSCodeSync · achievements");
  channel.clear();
  channel.appendLine("VSCodeSync — achievements");
  channel.appendLine("─".repeat(48));
  if (evaluated.length === 0) {
    channel.appendLine("Пока ни одного. Используйте Push / Pull для старта.");
    channel.show(true);
    return;
  }
  for (const a of evaluated) {
    const seen = known.has(a.id) ? "✓" : "⏺";
    const at = new Date(a.unlockedAtMs).toISOString();
    channel.appendLine(`  ${seen}  ${a.title.padEnd(20)} · ${a.description}  (${at})`);
  }
  channel.show(true);
}

/**
 * Schedule a single delayed evaluation 5 s after activate, so the popup
 * doesn't compete with the activation toast. Returns a Disposable that
 * cancels the timer if the extension deactivates first.
 */
export function scheduleAchievementsWarmup(
  context: vscode.ExtensionContext,
  storageDir: string,
): vscode.Disposable {
  const handle = setTimeout(() => {
    void runEvaluateAndPopup(context, storageDir);
  }, 5_000);
  return new vscode.Disposable(() => { clearTimeout(handle); });
}
