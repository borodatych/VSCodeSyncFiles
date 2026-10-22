/**
 * Реальные локальные хэши файлов, которые манифест предлагает принять под отслеживание
 *
 * Принятая строка получает базу из облака; если записать облачный хэш и как локальный,
 * Отличающийся файл на диске выглядит локальной правкой, и проход отправляет его в облако
 * Поэтому байты читаются здесь, а чистый планировщик получает готовый ответ
 */
import * as fs from "node:fs/promises";

/**
 * Хэш каждого неотслеживаемого кандидата, который есть на диске
 * Отсутствующий файл в ответ не попадает, нечитаемый получает пустой хэш
 * Уже отслеживаемые не читаются: их сверяет обычный проход, а чтение всех файлов на каждом цикле дорого
 */
export async function hashUntrackedLocalFiles(
  candidates: readonly string[],
  trackedKeys: readonly string[],
  absOf: (canonicalKey: string) => string,
  hashOf: (abs: string, canonicalKey: string) => Promise<string>,
): Promise<Map<string, string>> {
  const tracked = new Set(trackedKeys);
  const out = new Map<string, string>();
  for (const key of candidates) {
    if (tracked.has(key)) continue;
    const abs = absOf(key);
    const exists = await fs.access(abs).then(() => true, () => false);
    if (exists) out.set(key, await hashOf(abs, key).catch(() => ""));
  }
  return out;
}
