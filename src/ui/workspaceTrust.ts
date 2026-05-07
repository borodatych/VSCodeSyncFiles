import * as vscode from "vscode";

const RESTRICTED_HINT =
  "VSCodeSync: в Restricted Mode эта операция отключена. Доверьте папку workspace (Workspace Trust), затем повторите команду.";

/** false — пользователь в Restricted Mode, показано предупреждение. */
export async function assertWorkspaceTrusted(): Promise<boolean> {
  if (vscode.workspace.isTrusted) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(RESTRICTED_HINT, "Открыть Workspace Trust");
  if (choice === "Открыть Workspace Trust") {
    await vscode.commands.executeCommand("workbench.action.manageWorkspaceTrust");
  }
  return false;
}
