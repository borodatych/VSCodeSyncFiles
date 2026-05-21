/**
 * Centralised UI string table (Russian-first).
 *
 * Goal of U5: stop the en/ru drift where one tooltip says "Last sync"
 * and the next one says "Последняя синхронизация" for the same concept.
 * Components import named getters from here instead of hard-coding strings.
 *
 * Convention: keep keys snake_case and grouped by feature. Add `<name>_en`
 * variant when an explicit English form is also needed.
 *
 * This module is intentionally vscode-free — usable from pure helpers,
 * tests, and webview HTML builders.
 */

export interface SyncStatusLabels {
  ok: string;
  pendingPush: string;
  cloudNewer: string;
  conflict: string;
  syncing: string;
  paused: string;
}

export const syncStatusLabels: SyncStatusLabels = {
  ok: "Синхронизирован",
  pendingPush: "Ожидает push",
  cloudNewer: "Облако новее",
  conflict: "Конфликт",
  syncing: "Синхронизация…",
  paused: "На паузе",
};

export interface AutoSyncModeLabels {
  off: string;
  checkOnly: string;
  full: string;
}

export const autoSyncModeLabels: AutoSyncModeLabels = {
  off: "Авто-синхронизация выключена",
  checkOnly: "Авто: только проверка статусов",
  full: "Авто: полная синхронизация",
};

export interface ActionLabels {
  pull: string;
  push: string;
  resolve: string;
  cancel: string;
  yes: string;
  no: string;
  undo: string;
  retry: string;
}

export const actionLabels: ActionLabels = {
  pull: "Скачать",
  push: "Отправить",
  resolve: "Решить",
  cancel: "Отмена",
  yes: "Да",
  no: "Нет",
  undo: "Отменить",
  retry: "Повторить",
};

export interface CommonLabels {
  unknown: string;
  noFolderOpen: string;
  loading: string;
  errorTitle: string;
}

export const commonLabels: CommonLabels = {
  unknown: "—",
  noFolderOpen: "Нет открытой папки",
  loading: "Загрузка…",
  errorTitle: "VSCodeSync",
};

/** Tooltip builder: combines workspace + path + status into a uniform tooltip. */
export function buildFileTooltip(args: {
  workspaceNote: string;
  posixRel: string;
  status?: keyof SyncStatusLabels;
  editingByName?: string;
}): string {
  const statusLine = args.status ? `\n\n${syncStatusLabels[args.status]}` : "";
  const editingLine = args.editingByName
    ? `\n\n✏️ Редактируется на «${args.editingByName}»`
    : "";
  return `${args.workspaceNote}\n${args.posixRel}${statusLine}${editingLine}`;
}
