/**
 * v2.6.7 — config-change listeners extracted from `extension.ts`.
 *
 * Three orthogonal concerns:
 *
 *   1. `showFileDecorations` / `lineEnding` change → tell the file decorator
 *      to re-fetch its style.
 *   2. `encryption` flips on → ensure a DEK exists; nag the user to export
 *      it before switching machines.
 *   3. `watchIntervalSeconds` → warn when the value is below the safe floor
 *      (30 s) to protect provider quotas.
 *
 * Each branch reads the current setting on demand; no closure-bound state.
 * Caller pushes the returned `Disposable` into `context.subscriptions`.
 */
import * as vscode from "vscode";
import {
  ensureEncryptionKey,
  readEncryptionKey,
} from "../core/encryptionKey.js";
import type { SyncFileDecorationController } from "../ui/fileDecorations.js";

const CFG = "vscodesync";

export interface ConfigChangeListenerDeps {
  readonly context: vscode.ExtensionContext;
  readonly fileDecorations: SyncFileDecorationController;
}

export function registerConfigChangeListeners(
  deps: ConfigChangeListenerDeps,
): vscode.Disposable {
  const { context, fileDecorations } = deps;

  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration(`${CFG}.showFileDecorations`) ||
      e.affectsConfiguration(`${CFG}.lineEnding`)
    ) {
      fileDecorations.refresh();
    }
    if (e.affectsConfiguration(`${CFG}.encryption`)) {
      void handleEncryptionFlip(context);
    }
    if (e.affectsConfiguration(`${CFG}.watchIntervalSeconds`)) {
      handleWatchIntervalChange();
    }
  });
}

async function handleEncryptionFlip(
  context: vscode.ExtensionContext,
): Promise<void> {
  const on = vscode.workspace.getConfiguration(CFG).get<boolean>("encryption", false);
  if (!on) return;
  const existing = await readEncryptionKey(context.secrets);
  if (existing) return;
  await ensureEncryptionKey(context.secrets);
  const choice = await vscode.window.showWarningMessage(
    "VSCodeSync: шифрование включено. Ключ AES-256 сгенерирован и сохранён в системный keychain. Сохраните резервную копию через «VSCodeSync: Export Encryption Key».",
    "Экспортировать сейчас",
  );
  if (choice === "Экспортировать сейчас") {
    await vscode.commands.executeCommand("vscodesync.exportEncryptionKey");
  }
}

function handleWatchIntervalChange(): void {
  const sec = vscode.workspace.getConfiguration(CFG).get<number>("watchIntervalSeconds", 30);
  if (sec >= 30) return;
  void vscode.window.showWarningMessage(
    `VSCodeSync: watchIntervalSeconds = ${String(sec)} — рекомендуется ≥ 30 сек. Слишком частый polling может исчерпать лимиты API провайдера.`,
  );
}
