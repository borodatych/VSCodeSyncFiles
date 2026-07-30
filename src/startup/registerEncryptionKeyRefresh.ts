/**
 * Keeps the engine factory's encryption key current.
 *
 * The key used to be an optional fifth argument of `makeEngine`, and 17 of the
 * 24 construction sites never passed it — six of them could not, the parameter
 * was absent from their dependency type. With encryption enabled those engines
 * uploaded plaintext over encrypted blobs and wrote ciphertext over the user's
 * local files. The factory now owns the key, and this module owns keeping it
 * fresh, so no call site has anything left to forget.
 */
import * as vscode from "vscode";
import type { EngineFactory } from "./_engineFactory.js";
import { CONFIG_SECTION } from "../core/extensionIdentity.js";

export function registerEncryptionKeyRefresh(
  context: vscode.ExtensionContext,
  engineFactory: EngineFactory,
): void {
  // Prime the cache before any engine exists. The engine refuses blob work
  // while encryption is on and the key is missing, so the brief window before
  // this first read resolves fails loudly instead of writing plaintext.
  void engineFactory.refreshEncryptionKey();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.encryption`)) {
        void engineFactory.refreshEncryptionKey();
      }
    }),
    // Covers rotation and first-time creation regardless of which command did
    // it — nobody has to remember to notify the factory.
    context.secrets.onDidChange(() => {
      void engineFactory.refreshEncryptionKey();
    }),
  );
}
