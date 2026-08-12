/**
 * The one batch mover behind every «Переместить у меня»: physically lay local
 * files out along their new canonical structure, with progress and per-file
 * error tolerance. Both sides of a canonical rename share it — the machines
 * replaying someone else's move (engine factory toast) and the author machine
 * right after its own batch. `workspace.fs.rename` fires onDidRenameFiles, so
 * the engine's rebind branch re-keys each moved file without questions.
 */
import * as vscode from "vscode";

export interface LocalStructureMove {
  /** Machine-local posix path the bytes live at now. */
  fromRel: string;
  /** New placement, machine-local posix path. */
  toRel: string;
}

export async function moveLocalFilesWithProgress(
  workspaceRoot: string,
  moves: readonly LocalStructureMove[],
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "VSCodeSync: перенос файлов по новой структуре",
      cancellable: true,
    },
    async (progress, token) => {
      let done = 0;
      const failed: string[] = [];
      for (const m of moves) {
        if (token.isCancellationRequested) break;
        try {
          const oldUri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), ...m.fromRel.split("/"));
          const newUri = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), ...m.toRel.split("/"));
          const parent = vscode.Uri.joinPath(newUri, "..");
          await vscode.workspace.fs.createDirectory(parent);
          await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
        } catch (e) {
          failed.push(`${m.fromRel}: ${e instanceof Error ? e.message : String(e)}`);
        }
        done++;
        progress.report({ increment: 100 / moves.length, message: `${String(done)}/${String(moves.length)}` });
      }
      if (failed.length > 0) {
        void vscode.window.showErrorMessage(
          `VSCodeSync: не перенесено ${String(failed.length)} файлов — ${failed[0]}${failed.length > 1 ? " …" : ""}`,
        );
      }
    },
  );
}
