/**
 * CodeLens / Hover provider wiring — extracted from `extension.ts`
 * (Phase 0 / v2.11.3).
 *
 * Registers 4 providers and their refresh subscriptions:
 *   - Last-sync CodeLens over every tracked file.
 *   - Inline conflict CodeLens over `<<< / === / >>>` marker blocks.
 *   - Conflict hot-zone CodeLens that flags lines from past resolved conflicts.
 *   - Hover Diff Preview MarkdownString hover.
 *
 * Behaviour is preserved verbatim — refresh triggers, debounce heuristics,
 * setting toggles all match the previous inline activate() block.
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { SyncLastSyncCodeLensProvider } from "../ui/lastSyncCodeLens.js";
import { InlineConflictCodeLensProvider } from "../ui/inlineConflictCodeLens.js";
import {
  ConflictHotZoneCodeLensProvider,
  makeToRelPath,
} from "../ui/conflictHotZoneCodeLens.js";
import { HoverDiffPreviewProvider } from "../ui/hoverDiffPreviewProvider.js";

export interface CodeLensProvidersDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
}

export function registerCodeLensProviders(deps: CodeLensProvidersDeps): void {
  const { context, globalConfig } = deps;

  const lastSyncLens = new SyncLastSyncCodeLensProvider();
  context.subscriptions.push(
    lastSyncLens,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lastSyncLens),
    vscode.workspace.onDidSaveTextDocument(() => { lastSyncLens.refresh(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscodesync.codeLens")) lastSyncLens.refresh();
    }),
  );

  const inlineConflictLens = new InlineConflictCodeLensProvider(
    () => vscode.workspace.getConfiguration("vscodesync").get<boolean>("aiMerge.enabled", false),
  );
  context.subscriptions.push(
    inlineConflictLens,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, inlineConflictLens),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Only refresh when the changed document might have markers — cheap heuristic.
      const text = e.document.getText();
      if (text.includes("<<<<<<<") || text.includes(">>>>>>>")) inlineConflictLens.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("vscodesync.inlineConflictCodeLens") ||
        e.affectsConfiguration("vscodesync.aiMerge.enabled")
      ) {
        inlineConflictLens.refresh();
      }
    }),
  );

  const hotZoneLens = new ConflictHotZoneCodeLensProvider({
    storageDir: globalConfig.getStorageDir(),
    toRelPath: makeToRelPath(),
  });
  context.subscriptions.push(
    hotZoneLens,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, hotZoneLens),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscodesync.conflictHotZoneCodeLens")) hotZoneLens.refresh();
    }),
  );

  const hoverDiff = new HoverDiffPreviewProvider();
  context.subscriptions.push(
    hoverDiff,
    vscode.languages.registerHoverProvider({ scheme: "file" }, hoverDiff),
    vscode.workspace.onDidSaveTextDocument(() => { hoverDiff.refresh(); }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscodesync.hoverDiffPreview")) hoverDiff.refresh();
    }),
  );
}
