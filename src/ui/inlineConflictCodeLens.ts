/**
 * Inline CodeLens above git-style conflict marker blocks.
 *
 * The actual scanner is in `conflictMarkerScanner.ts` (vscode-free, covered by
 * unit tests). This module wraps it in the VS Code CodeLensProvider surface.
 */
import * as vscode from "vscode";
import { scanConflictMarkers } from "./conflictMarkerScanner.js";

export class InlineConflictCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly aiMergeAvailable: () => boolean) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const enabled = vscode.workspace
      .getConfiguration("vscodesync")
      .get<boolean>("inlineConflictCodeLens.enabled", true);
    if (!enabled) return [];
    const blocks = scanConflictMarkers(document);
    if (blocks.length === 0) return [];
    const aiOn = this.aiMergeAvailable();
    const lenses: vscode.CodeLens[] = [];
    for (const block of blocks) {
      const top = new vscode.Range(block.startLine, 0, block.startLine, 0);
      lenses.push(
        new vscode.CodeLens(top, {
          title: "$(check) Keep mine",
          command: "vscodesync.keepMine",
          arguments: [document.uri],
        }),
        new vscode.CodeLens(top, {
          title: "$(arrow-down) Take theirs",
          command: "vscodesync.takeTheirs",
          arguments: [document.uri],
        }),
      );
      if (aiOn) {
        // No standalone "AI merge this file" command exists yet; route through
        // the resolve-conflicts flow which already wires AI merge.
        lenses.push(
          new vscode.CodeLens(top, {
            title: "$(sparkle) AI merge",
            command: "vscodesync.resolveConflicts",
          }),
        );
      }
    }
    return lenses;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
