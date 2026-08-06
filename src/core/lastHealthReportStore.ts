/**
 * In-memory record of the most recent Health Check run.
 *
 * The support bundle promises a `health-check.txt`, but the report was only
 * ever printed to an output channel, which cannot be read back. Rebuilding the
 * report during the export is not an option either — it talks to the cloud, and
 * a support bundle must be collectable while the extension is wedged. Keeping
 * the last run in memory gives the bundle real content without any I/O.
 */

interface StoredHealthReport {
  readonly lines: readonly string[];
  readonly capturedAtIso: string;
}

let last: StoredHealthReport | null = null;

/** Record the lines a Health Check just produced. */
export function setLastHealthReport(lines: readonly string[], nowIso?: string): void {
  last = { lines: [...lines], capturedAtIso: nowIso ?? new Date().toISOString() };
}

/** Most recent Health Check output, or null when none ran this session. */
export function getLastHealthReport(): StoredHealthReport | null {
  return last;
}

/** Test seam. */
export function resetLastHealthReport(): void {
  last = null;
}
