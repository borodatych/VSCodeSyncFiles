/**
 * Time Travel scrubber — skeleton.
 *
 * Goal: a slider over .history/{path}/ snapshots that lets the user scrub
 * across versions in real time. The pure helper here orders versions and
 * produces a tick model that the future slider widget will bind to.
 *
 * Slider rendering itself throws a sentinel — UI must catch and route to
 * a "needs work" placeholder.
 */

export class TimeTravelScrubberNotImplementedError extends Error {
  constructor(message = "Time Travel scrubber UI is not implemented yet") {
    super(message);
    this.name = "TimeTravelScrubberNotImplementedError";
  }
}

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

export function renderScrubber(_model: TimeTravelModel): never {
  throw new TimeTravelScrubberNotImplementedError();
}
