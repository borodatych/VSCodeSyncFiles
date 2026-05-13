/**
 * One-shot migration for the renamed AI-merge flag.
 *
 * History: until v0.6.1 the boolean toggle lived at `vscodesync.aiMerge`,
 * but the package.json also exposed sibling keys `vscodesync.aiMerge.endpoint`
 * and `vscodesync.aiMerge.endpointModel`. VS Code's configuration model
 * cannot host a boolean leaf and a child object under the same path, so
 * every settings-tree build emitted a (red) `Ignoring vscodesync.aiMerge.endpoint
 * as vscodesync.aiMerge is false` error.
 *
 * Fix: the boolean is now `vscodesync.aiMerge.enabled`. This migration
 * carries forward any value the user previously set, per-scope, and clears
 * the legacy key so the conflict goes away.
 *
 * Fire-and-forget; failures don't block activate.
 */
import * as vscode from "vscode";

const CFG_SECTION = "vscodesync";
const LEGACY_KEY = "aiMerge";
const NEW_KEY = "aiMerge.enabled";

interface MigratableScope {
  readonly target: vscode.ConfigurationTarget;
  readonly read: (info: ReturnType<vscode.WorkspaceConfiguration["inspect"]>) => unknown;
}

const SCOPES: readonly MigratableScope[] = [
  { target: vscode.ConfigurationTarget.Global, read: (i) => i?.globalValue },
  { target: vscode.ConfigurationTarget.Workspace, read: (i) => i?.workspaceValue },
  { target: vscode.ConfigurationTarget.WorkspaceFolder, read: (i) => i?.workspaceFolderValue },
];

export function migrateAiMergeFlag(): void {
  void (async (): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
    const legacy = cfg.inspect<boolean>(LEGACY_KEY);
    if (legacy === undefined) return;

    for (const scope of SCOPES) {
      const value = scope.read(legacy);
      if (value === undefined) continue;
      try {
        await cfg.update(NEW_KEY, value, scope.target);
        await cfg.update(LEGACY_KEY, undefined, scope.target);
      } catch {
        // Settings may be read-only in some workspace configurations
        // (e.g. remote/codespace overrides). Best-effort.
      }
    }
  })();
}
