/**
 * v3.N — pure playback engine for sync-replay viewer.
 *
 * Input: a list of replay events sorted by `tsMs`. Output: a stateful cursor
 * the UI can drive: seek, step, play at N events/sec.
 *
 * Cursor advances by *event index*, not wall-clock — playback speed is then
 * "release one event every (1 / eventsPerSec) ms". The UI runs the timer;
 * this module is pure.
 *
 * No `vscode` import.
 */

export interface ReplayEvent {
  tsMs: number;
  /** Free-form event kind (push / pull / conflict / etc). */
  kind: string;
  /** Optional file path for filter-by-file. */
  relPath?: string;
  /** Originating machine for filter-by-machine. */
  machineName?: string;
  /** Free-form payload. */
  detail?: unknown;
}

export interface ReplayCursor {
  /** Index into the events array — points at the *next* event to release. */
  next: number;
  /** Total events. */
  total: number;
  /** True when `next === total`. */
  atEnd: boolean;
}

export interface ReplayFilter {
  kinds?: string[];
  files?: string[];
  machines?: string[];
}

/** Filter events by the supplied predicates. Pure — returns a fresh array;
 * caller indexes into it for cursor math. */
export function filterReplayEvents(events: ReplayEvent[], filter: ReplayFilter): ReplayEvent[] {
  return events.filter((e) => {
    if (filter.kinds && !filter.kinds.includes(e.kind)) return false;
    if (filter.files && (e.relPath === undefined || !filter.files.includes(e.relPath))) return false;
    if (filter.machines && (e.machineName === undefined || !filter.machines.includes(e.machineName))) {
      return false;
    }
    return true;
  });
}

/** Make a cursor at index `next` (default 0). Pure; cursor immutable. */
export function makeReplayCursor(total: number, next = 0): ReplayCursor {
  const clampedNext = Math.max(0, Math.min(next, total));
  return { next: clampedNext, total, atEnd: clampedNext >= total };
}

/** Advance by one event. Returns `null` if already at end. */
export function stepReplayCursor(cursor: ReplayCursor): ReplayCursor | null {
  if (cursor.atEnd) return null;
  return makeReplayCursor(cursor.total, cursor.next + 1);
}

/** Seek by absolute timestamp using the events array (which must be sorted
 * by `tsMs`). Cursor lands on the first event with `tsMs >= seekToMs`. */
export function seekReplayByTime(events: ReplayEvent[], seekToMs: number): ReplayCursor {
  // Binary search for first event with tsMs >= seekToMs.
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].tsMs < seekToMs) lo = mid + 1;
    else hi = mid;
  }
  return makeReplayCursor(events.length, lo);
}

/** How many events to release in this animation tick given target rate +
 * elapsed wall-clock. Caller calls this each tick and applies `count` events
 * to the cursor via `stepReplayCursor` in a loop. */
export function eventsToReleasePerTick(
  eventsPerSec: number,
  elapsedSinceLastTickMs: number,
  carry = 0,
): { count: number; nextCarry: number } {
  if (eventsPerSec <= 0) return { count: 0, nextCarry: 0 };
  const float = (elapsedSinceLastTickMs * eventsPerSec) / 1000 + carry;
  const count = Math.floor(float);
  return { count, nextCarry: float - count };
}
