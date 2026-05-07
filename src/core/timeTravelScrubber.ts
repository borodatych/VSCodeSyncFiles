/**
 * Time Travel scrubber — pure model + filename parser.
 *
 * The slider widget lives in `src/ui/timeTravelScrubberPanel.ts`; this
 * module produces the tick layout and parses the `.history/{relPath}/`
 * filename convention (`STAMP_machineName.ext`) into a structured
 * HistoryVersion record.
 */

export interface HistoryVersion {
  cloudPath: string;
  createdAtMs: number;
  machineName: string;
  size: number;
}

export interface TimeTravelTick {
  index: number;
  version: HistoryVersion;
  /** Position on the slider in [0, 1]. */
  positionFraction: number;
}

export interface TimeTravelModel {
  ticks: TimeTravelTick[];
  earliestMs: number;
  latestMs: number;
  totalSpanMs: number;
}

export function buildTimeTravelModel(versions: readonly HistoryVersion[]): TimeTravelModel {
  if (versions.length === 0) {
    return { ticks: [], earliestMs: 0, latestMs: 0, totalSpanMs: 0 };
  }
  const sorted = [...versions].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const earliestMs = sorted[0].createdAtMs;
  const latestMs = sorted[sorted.length - 1].createdAtMs;
  const totalSpanMs = Math.max(latestMs - earliestMs, 1);
  const ticks: TimeTravelTick[] = sorted.map((version, index) => ({
    index,
    version,
    positionFraction: (version.createdAtMs - earliestMs) / totalSpanMs,
  }));
  return { ticks, earliestMs, latestMs, totalSpanMs };
}

/**
 * Parse a `.history/{relPath}/STAMP_machineName.ext` cloudPath into a
 * structured version record. The STAMP format is the one written by
 * `syncEngine.snapshotHistory`: ISO 8601 with `:` and `.` replaced by `-`,
 * e.g. `2026-05-08T01-23-45-678Z`. Returns null on shape mismatch — never
 * throws on bad input (this is the trust boundary for what the cloud
 * provider returns from listFolder).
 */
export function parseHistoryFilename(cloudPath: string, size = 0): HistoryVersion | null {
  const filename = cloudPath.split("/").pop();
  if (!filename) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+?)(?:\.[^.]*)?$/.exec(filename);
  if (!m) return null;
  const [, stamp, machineName] = m;
  const iso = stamp.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1:$2:$3.$4Z",
  );
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return { cloudPath, createdAtMs: t, machineName, size };
}
