/**
 * Подтверждение ручной отправки поверх более новой облачной версии
 *
 * Ручная отправка не скачивает облако и перезаписывает его без сверки,
 * Поэтому файл новее в облаке или в конфликте уходит только с согласия пользователя
 */
import * as vscode from "vscode";
import type { WorkspaceConfig } from "../core/types.js";

/** Сколько путей показывается в окне — весь список окно не вместит */
const SAMPLE_PATHS_LIMIT = 5;

const CONFIRM = "Отправить";

/**
 * Одно модальное подтверждение на весь набор, если в нём есть файлы новее в облаке или в конфликте
 * Возвращает `true`, когда отправлять можно
 */
export async function confirmPushOverNewerCloud(
  cfg: WorkspaceConfig,
  targets: readonly { workspaceId: string; localPath: string }[],
): Promise<boolean> {
  const ahead = targets.filter((t) => {
    const st = cfg.files.find((r) => r.workspaceId === t.workspaceId && r.localPath === t.localPath)?.syncStatus;
    return st === "cloud_newer" || st === "conflict";
  });
  if (ahead.length === 0) {
    return true;
  }
  const names = ahead.slice(0, SAMPLE_PATHS_LIMIT).map((t) => t.localPath).join("\n");
  const picked = await vscode.window.showWarningMessage(
    "Облако новее. Отправить всё равно? Облачная версия сохранится в истории.",
    { modal: true, detail: `${names}${ahead.length > SAMPLE_PATHS_LIMIT ? "\n…" : ""}` },
    CONFIRM,
  );
  return picked === CONFIRM;
}
