const SYNC_START = "vsync-ignore-start";
const SYNC_END = "vsync-ignore-end";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Внутренности блоков vsync по порядку появления. */
export function extractSyncignoreInners(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const inners: string[] = [];
  let skipping = false;
  let cur: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes(SYNC_START)) {
      skipping = true;
      cur = [];
      continue;
    }
    if (trimmed.includes(SYNC_END)) {
      skipping = false;
      inners.push(cur.join("\n"));
      cur = [];
      continue;
    }
    if (skipping) {
      cur.push(line);
    }
  }
  return inners;
}

/** Удаляет блоки между маркерами (строки с маркерами тоже выкидываются). */
export function stripSyncignoreBlocks(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes(SYNC_START)) {
      skipping = true;
      continue;
    }
    if (trimmed.includes(SYNC_END)) {
      skipping = false;
      continue;
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** Для каждого блока в `cloud` подставляет inner из `local` с тем же индексом, если есть. */
export function mergeSyncignoreFromCloud(local: string, cloud: string): string {
  const localInners = extractSyncignoreInners(local);
  const pattern = new RegExp(
    `${escapeRegExp(SYNC_START)}[\\s\\S]*?${escapeRegExp(SYNC_END)}`,
    "g",
  );
  let i = 0;
  return cloud.replace(pattern, () => {
    const inner = localInners.at(i);
    i += 1;
    return `${SYNC_START}\n${inner ?? ""}\n${SYNC_END}`;
  });
}
