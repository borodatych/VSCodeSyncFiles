import * as vscode from "vscode";
import { workspaceHealthColorId, type WorkspaceHealthLevel } from "./workspaceHealthLocal.js";

/**
 * Build the `vscode.ThemeColor` used to tint the workspace's cloud icon
 * in the tree view. Thin wrapper over the pure `workspaceHealthColorId`
 * mapping — isolated from `workspaceHealthLocal.ts` so the latter stays
 * `vscode`-free and unit-testable.
 */
export function workspaceHealthThemeColor(level: WorkspaceHealthLevel): vscode.ThemeColor {
  return new vscode.ThemeColor(workspaceHealthColorId(level));
}
