/**
 * v0.15 W04 — host wiring for `planContextualHints`.
 *
 * On window-focus regain (and at activation tick), gather state, ask the
 * pure planner for hints, and surface ONE at a time via
 * `showInformationMessage`. Each hint is deduped via `globalState` for
 * a settable window so we don't badger the user.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import {
  planContextualHints,
  type ContextualHint,
} from "../core/contextualHintsPlanner.js";
import { parseAutoSyncMode, isAutoCheckEnabled } from "../core/autoSyncMode.js";
import { normalizeWorkspaceSyncState } from "../core/types.js";

const CFG = "vscodesync";
const DEDUP_KEY_PREFIX = "vscodesync.contextualHints.dedup.";
/** A hint with the same id won't reappear within this window. */
const DEDUP_WINDOW_MS = 6 * 3600_000; // 6 hours

export interface ContextualHintsSchedulerDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
}

export function registerContextualHintsScheduler(deps: ContextualHintsSchedulerDeps): vscode.Disposable {
  const { context } = deps;

  const isEnabled = (): boolean => {
    return vscode.workspace.getConfiguration(CFG).get<boolean>("hints.enabled", true);
  };

  const shouldShow = (id: string, now: number): boolean => {
    const key = `${DEDUP_KEY_PREFIX}${id}`;
    const lastShown = context.globalState.get<number>(key) ?? 0;
    return now - lastShown >= DEDUP_WINDOW_MS;
  };

  const noteShown = async (id: string, now: number): Promise<void> => {
    const key = `${DEDUP_KEY_PREFIX}${id}`;
    await context.globalState.update(key, now);
  };

  const run = async (): Promise<void> => {
    // v0.17 A5 — early exit guards check enable flag BEFORE writing any
    // globalState (so disabled users don't accumulate stale keys).
    if (!isEnabled()) return;
    if (!vscode.workspace.isTrusted) return;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return;

    let conflictCount = 0;
    let activeCount = 0;
    let allFrozen = true;
    for (const folder of folders) {
      try {
        const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
        for (const f of wc.files) {
          if (f.syncStatus === "conflict") conflictCount += 1;
        }
        for (const ws of wc.activeWorkspaces) {
          activeCount += 1;
          if (normalizeWorkspaceSyncState(ws) !== "frozen") {
            allFrozen = false;
          }
        }
      } catch { /* non-fatal */ }
    }
    if (activeCount === 0) allFrozen = false;

    const autoMode = parseAutoSyncMode(
      vscode.workspace.getConfiguration(CFG).get<string>("autoSyncMode", "check-only"),
    );
    let autoSyncOffSinceMs: number | undefined;
    if (!isAutoCheckEnabled(autoMode)) {
      const key = "vscodesync.contextualHints.autoModeOffSince";
      const recorded = context.globalState.get<number>(key);
      if (recorded === undefined) {
        await context.globalState.update(key, Date.now());
      } else {
        autoSyncOffSinceMs = recorded;
      }
    } else {
      await context.globalState.update("vscodesync.contextualHints.autoModeOffSince", undefined);
    }

    const nowMs = Date.now();
    const hints: ContextualHint[] = planContextualHints({
      conflictCount,
      allWorkspacesFrozen: allFrozen,
      activeWorkspaceCount: activeCount,
      autoSyncOffSinceMs,
      nowMs,
    });

    // Show first hint that's not in cooldown.
    for (const hint of hints) {
      if (!shouldShow(hint.id, nowMs)) continue;
      const actions = hint.actionCommandId ? ["Открыть", "Игнорировать"] : ["OK"];
      // v0.17 A5 — record cooldown ONLY after the message has been shown
      // successfully. If `showXxxMessage` rejects (shutdown, host crash),
      // we keep eligibility so the user sees the hint on next focus.
      let picked: string | undefined;
      try {
        picked = await (hint.severity === "warn"
          ? vscode.window.showWarningMessage(hint.text, ...actions)
          : vscode.window.showInformationMessage(hint.text, ...actions));
      } catch {
        return;
      }
      await noteShown(hint.id, nowMs);
      if (picked === "Открыть" && hint.actionCommandId) {
        try {
          await vscode.commands.executeCommand(hint.actionCommandId);
        } catch { /* command may not exist — silently ignore */ }
      }
      break;
    }
  };

  const sub = vscode.window.onDidChangeWindowState((s) => {
    if (s.focused) void run();
  });
  // Initial check 30s after activate to avoid startup noise.
  const t = setTimeout(() => { void run(); }, 30_000);
  return new vscode.Disposable(() => {
    sub.dispose();
    clearTimeout(t);
  });
}
