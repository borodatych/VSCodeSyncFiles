/**
 * File I/O wrapper for the pure `conflictHeatmapStore`. Keeps file-system
 * concerns out of the pure module so unit tests don't need temp dirs.
 *
 * Storage location: `{storageDir}/conflicts.json` (next to `activity.json`,
 * `queue.json`, etc).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeTextFileAtomic } from "../core/writeTextFileAtomic.js";
import {
  appendConflictEntry,
  buildHotZones,
  emptyConflictLog,
  parseConflictLog,
  type ConflictLogFile,
  type HotZone,
} from "../core/conflictHeatmapStore.js";

const FILE_NAME = "conflicts.json";

function filePath(storageDir: string): string {
  return path.join(storageDir, FILE_NAME);
}

export async function loadConflictLog(storageDir: string): Promise<ConflictLogFile> {
  try {
    const raw = await fs.readFile(filePath(storageDir), "utf8");
    return parseConflictLog(JSON.parse(raw));
  } catch {
    return emptyConflictLog();
  }
}

/**
 * Append a file-level conflict entry. Line range defaults to `1..1` — the
 * resolve commands don't expose line numbers; the buildHotZones helper still
 * works (overlapping 1..1 entries collapse into a single per-file zone).
 */
export async function recordConflictResolution(
  storageDir: string,
  relPath: string,
  startLine = 1,
  endLine = 1,
): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });
  const prev = await loadConflictLog(storageDir);
  const next = appendConflictEntry(prev, {
    relPath,
    lineRangeStart: startLine,
    lineRangeEnd: endLine,
    at: new Date().toISOString(),
  });
  await writeTextFileAtomic(filePath(storageDir), `${JSON.stringify(next, null, 2)}\n`);
}

export async function getHotZones(storageDir: string, threshold = 3): Promise<HotZone[]> {
  const log = await loadConflictLog(storageDir);
  return buildHotZones(log, threshold);
}
