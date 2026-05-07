import * as vscode from "vscode";
import type { SyncEngine } from "../core/syncEngine.js";
import type { PreviewSyncFileAction, SyncPreviewWorkspace } from "../core/syncEngine.js";

const CFG_SECTION = "vscodesync";

export function previewActionLabel(a: PreviewSyncFileAction): string {
  switch (a) {
    case "none":
      return "— без изменений";
    case "push":
      return "↑ push";
    case "pull":
      return "↓ pull";
    case "conflict":
      return "⚠ конфликт";
    case "conflict_pending":
      return "⚠ конфликт (ждёт решения)";
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

export function writeSyncPreviewOutput(channel: vscode.OutputChannel, plan: SyncPreviewWorkspace[]): void {
  channel.clear();
  channel.appendLine("VSCodeSync · Preview Sync (только чтение облака, локальный конфиг не меняется)");
  channel.appendLine("");
  if (plan.length === 0) {
    channel.appendLine("Нет данных: нет активных workspace или они отфильтрованы.");
    return;
  }
  for (const ws of plan) {
    channel.appendLine(`━━ ${ws.workspaceNote} (${ws.workspaceId}) ━━`);
    if (ws.files.length === 0) {
      channel.appendLine("  (нет отслеживаемых файлов по манифесту)");
    } else {
      for (const row of ws.files) {
        channel.appendLine(`  ${previewActionLabel(row.action).padEnd(26, " ")} ${row.localPath}`);
      }
    }
    channel.appendLine("");
  }
  channel.appendLine(
    "Это ожидаемые действия ветки sync по файлам (как в Sync Workspace), без учёта отдельного шага Push All для «грязного» localHash.",
  );
}

function tally(files: SyncPreviewWorkspace["files"]): {
  pull: number;
  push: number;
  conflict: number;
  none: number;
} {
  let pull = 0;
  let push = 0;
  let conflict = 0;
  let none = 0;
  for (const f of files) {
    switch (f.action) {
      case "pull":
        pull++;
        break;
      case "push":
        push++;
        break;
      case "conflict":
      case "conflict_pending":
        conflict++;
        break;
      case "none":
        none++;
        break;
      default:
        break;
    }
  }
  return { pull, push, conflict, none };
}

/**
 * When `vscodesync.showPreview` is true: download preview plan, write Output channel, modal confirm.
 * @returns whether to proceed with the bulk operation.
 */
export async function confirmTreeWorkspaceBulkSyncIfNeeded(
  engine: SyncEngine,
  channel: vscode.OutputChannel,
  workspaceId: string,
  workspaceNote: string,
  operation: "push" | "pull" | "sync",
): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
  if (!cfg.get<boolean>("showPreview", true)) {
    return true;
  }
  let plan: SyncPreviewWorkspace[];
  try {
    plan = await engine.previewSyncPlan(workspaceId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await vscode.window.showErrorMessage(`VSCodeSync Preview: ${msg}`);
    return false;
  }
  writeSyncPreviewOutput(channel, plan);
  channel.show(true);
  const ws = plan.find((w) => w.workspaceId === workspaceId);
  const files = ws?.files ?? [];
  const { pull, push, conflict, none } = tally(files);
  const opTitle =
    operation === "push" ? "Push All" : operation === "pull" ? "Pull All" : "Sync Workspace";
  const picked = await vscode.window.showWarningMessage(
    `Preview: ${opTitle} — «${workspaceNote}»\n\n↓ pull ${String(pull)} · ↑ push ${String(push)} · конфликты ${String(conflict)} · без изменений ${String(none)}\n\nПодробности — Output «VSCodeSync · Preview».`,
    { modal: true },
    "Выполнить",
    "Отмена",
  );
  return picked === "Выполнить";
}
