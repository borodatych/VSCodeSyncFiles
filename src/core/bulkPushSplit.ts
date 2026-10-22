/**
 * Разделение набора массовой отправки по свежим статусам
 *
 * Строки панели взяты из статусов, которые могли устареть,
 * Поэтому после пересчёта файлы с более новым облаком отделяются: они уходят только с согласия пользователя
 */
import type { TrackedFile } from "./types.js";

export interface BulkPushTarget {
  workspaceId: string;
  localPath: string;
}

export interface BulkPushSplit<T extends BulkPushTarget> {
  /** Облако новее или конфликт: отправка затрёт чужую версию, нужно подтверждение и userForce */
  aheadInCloud: T[];
  /** Остальные: уходят обычной отправкой со сверкой с облаком */
  plain: T[];
}

export function splitBulkPushByFreshStatus<T extends BulkPushTarget>(
  files: readonly Pick<TrackedFile, "workspaceId" | "localPath" | "syncStatus">[],
  targets: readonly T[],
): BulkPushSplit<T> {
  const aheadInCloud: T[] = [];
  const plain: T[] = [];
  for (const t of targets) {
    const st = files.find((f) => f.workspaceId === t.workspaceId && f.localPath === t.localPath)?.syncStatus;
    if (st === "cloud_newer" || st === "conflict") aheadInCloud.push(t);
    else plain.push(t);
  }
  return { aheadInCloud, plain };
}
