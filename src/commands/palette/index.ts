/**
 * The palette command groups, registered together (F12).
 *
 * `extension.ts` calls one function, as it did when this was a single
 * 1115-line module; the difference is that the seven domains are now seven
 * files, and adding an eighth does not touch `activate()`.
 */
import * as vscode from "vscode";
import type { PaletteExtras } from "./_shared.js";
import { registerPauseAndWatch } from "./pauseAndWatch.js";
import { registerSnapshotCommands } from "./snapshotCommands.js";
import { registerEncryptionKeyCommands } from "./encryptionKeyCommands.js";
import { registerWorkspaceStructureCommands } from "./workspaceStructureCommands.js";
import { registerInsightsPanelCommands } from "./insightsPanelCommands.js";
import { registerSyncDiagnosticsCommands } from "./syncDiagnosticsCommands.js";
import { registerWorkspaceLayoutCommands } from "./workspaceLayoutCommands.js";

export type { PaletteExtras } from "./_shared.js";

export function registerPaletteCommands(
  context: vscode.ExtensionContext,
  extras: PaletteExtras,
): void {
  registerPauseAndWatch(context, extras);
  registerSnapshotCommands(context, extras);
  registerEncryptionKeyCommands(context, extras);
  registerWorkspaceStructureCommands(context, extras);
  registerInsightsPanelCommands(context, extras);
  registerSyncDiagnosticsCommands(context, extras);
  registerWorkspaceLayoutCommands(context, extras);
}
