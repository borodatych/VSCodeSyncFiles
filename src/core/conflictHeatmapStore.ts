/**
 * Pure store for conflict-heatmap data: each resolved conflict is appended
 * with `{relPath, lineRangeStart, lineRangeEnd, at}`. Aggregation produces
 * "hot lines" — line ranges that have been part of conflicts ≥ N times.
 *
 * vscode-free; the UI layer wraps it with file I/O via `writeTextFileAtomic`.
 */

export interface ConflictLogEntry {
  /** Workspace-relative POSIX path of the file. */
  relPath: string;
  /** 1-based inclusive line numbers at the time of conflict resolution. */
  lineRangeStart: number;
  lineRangeEnd: number;
  /** ISO-8601 instant of resolution. */
  at: string;
}

export interface ConflictLogFile {
  schema: 1;
  entries: ConflictLogEntry[];
}

export const DEFAULT_HOT_THRESHOLD = 3;
export const DEFAULT_RETENTION_DAYS = 180;
export const MAX_ENTRIES = 5000;

export function emptyConflictLog(): ConflictLogFile {
  return { schema: 1, entries: [] };
}

/** Coerce arbitrary parsed JSON into a valid log; never throws. */
export function parseConflictLog(raw: unknown): ConflictLogFile {
  if (typeof raw !== "object" || raw === null) return emptyConflictLog();
  const obj = raw as { schema?: unknown; entries?: unknown };
  if (obj.schema !== 1 || !Array.isArray(obj.entries)) return emptyConflictLog();
  const entries: ConflictLogEntry[] = [];
  for (const e of obj.entries as unknown[]) {
    if (typeof e !== "object" || e === null) continue;
    const x = e as Partial<ConflictLogEntry>;
    if (
      typeof x.relPath !== "string" ||
      typeof x.lineRangeStart !== "number" ||
      typeof x.lineRangeEnd !== "number" ||
      typeof x.at !== "string"
    ) continue;
    if (x.lineRangeStart < 1 || x.lineRangeEnd < x.lineRangeStart) continue;
    entries.push({
      relPath: x.relPath,
      lineRangeStart: x.lineRangeStart,
      lineRangeEnd: x.lineRangeEnd,
      at: x.at,
    });
  }
  return { schema: 1, entries };
}

/** Append a new entry; trims to retention window + MAX_ENTRIES tail. */
export function appendConflictEntry(
  prev: ConflictLogFile,
  entry: ConflictLogEntry,
  now: number = Date.now(),
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): ConflictLogFile {
  const cutoff = now - retentionDays * 86_400_000;
  const filtered = prev.entries.filter((e) => {
    const t = Date.parse(e.at);
    return Number.isFinite(t) && t >= cutoff;
  });
  filtered.push(entry);
  const trimmed = filtered.length > MAX_ENTRIES ? filtered.slice(-MAX_ENTRIES) : filtered;
  return { schema: 1, entries: trimmed };
}

export interface HotZone {
  relPath: string;
  /** Min lineRangeStart across grouped entries. */
  startLine: number;
  /** Max lineRangeEnd. */
  endLine: number;
  /** How many resolved conflicts overlapped this zone. */
  count: number;
}

/**
 * Group entries per file, then per overlapping line-range cluster.
 * Two entries belong to the same cluster when their ranges overlap or touch.
 * Returns clusters with `count >= threshold`, sorted by count desc.
 */
export function buildHotZones(
  log: ConflictLogFile,
  threshold: number = DEFAULT_HOT_THRESHOLD,
): HotZone[] {
  const byFile = new Map<string, ConflictLogEntry[]>();
  for (const e of log.entries) {
    const list = byFile.get(e.relPath) ?? [];
    list.push(e);
    byFile.set(e.relPath, list);
  }
  const out: HotZone[] = [];
  for (const [relPath, list] of byFile) {
    const sorted = [...list].sort((a, b) => a.lineRangeStart - b.lineRangeStart);
    let cur: HotZone | undefined;
    for (const e of sorted) {
      if (!cur) {
        cur = { relPath, startLine: e.lineRangeStart, endLine: e.lineRangeEnd, count: 1 };
        continue;
      }
      // touch or overlap: extend the cluster
      if (e.lineRangeStart <= cur.endLine + 1) {
        cur.endLine = Math.max(cur.endLine, e.lineRangeEnd);
        cur.count++;
      } else {
        if (cur.count >= threshold) out.push(cur);
        cur = { relPath, startLine: e.lineRangeStart, endLine: e.lineRangeEnd, count: 1 };
      }
    }
    if (cur && cur.count >= threshold) out.push(cur);
  }
  return out.sort((a, b) => b.count - a.count);
}
