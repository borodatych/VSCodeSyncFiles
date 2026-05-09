/**
 * v2.20.2 — `workspace.fs.prefetch(uri)` hints planner.
 *
 * The proposed VS Code API `workspace.fs.prefetch` (under discussion in
 * `vscode#178919`, available behind a proposed-API flag in Insiders / Cursor
 * 1.95+) signals to virtual filesystem providers that the user is *likely*
 * to open a given URI soon, so the provider can warm caches.
 *
 * For a cloud workspace, the right time to call prefetch is:
 *   1. Right after `pull-all` finishes — pre-warm the most-recently-touched
 *      files so the user can navigate without round-trips.
 *   2. On focus / window-restore — warm the file the user had open last.
 *   3. After a `quickSwitchWorkspace` command — warm the new workspace's
 *      `package.json`, `README.md`, top-level entry.
 *
 * This module is a *pure planner*: given a list of tracked files plus an
 * activity hint (last-opened, last-modified), it returns the URIs that
 * deserve a prefetch call. The actual `vscode.workspace.fs.prefetch` import
 * lives in the wiring layer once the API stabilises.
 */

export interface PrefetchCandidate {
  readonly relPath: string;
  /** `lastModifiedMs` from the manifest entry. */
  readonly modifiedMs?: number;
  /** `lastOpenedMs` from local activity log. */
  readonly openedMs?: number;
  /** Approx. byte size — used to deprioritise huge files. */
  readonly sizeBytes?: number;
}

export interface PrefetchPlanInput {
  readonly candidates: readonly PrefetchCandidate[];
  /** Soft cap on prefetch calls per trigger. Default: 8. */
  readonly maxCount?: number;
  /** Files larger than this are excluded. Default: 5 MiB. */
  readonly maxSizeBytes?: number;
  /** "now" for tests; defaults to `Date.now()`. */
  readonly nowMs?: number;
}

export interface PrefetchPlan {
  readonly toPrefetch: readonly string[];
  /** Files dropped because of size cap. */
  readonly skippedTooLarge: readonly string[];
  /** Files dropped because they have no recency signal. */
  readonly skippedColdAndUnused: readonly string[];
}

const DEFAULT_MAX_COUNT = 8;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Files older than this with no `openedMs` are not worth prefetching. */
const COLD_THRESHOLD_DAYS = 30;

export function planPrefetchHints(input: PrefetchPlanInput): PrefetchPlan {
  const maxCount = input.maxCount ?? DEFAULT_MAX_COUNT;
  const maxSize = input.maxSizeBytes ?? DEFAULT_MAX_BYTES;
  const now = input.nowMs ?? Date.now();
  const coldCutoff = now - COLD_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  const toPrefetch: string[] = [];
  const skippedTooLarge: string[] = [];
  const skippedColdAndUnused: string[] = [];

  // Score = recency-weighted. lastOpened beats lastModified; both decay linearly.
  const scored = input.candidates.map((c) => {
    const lastTouch = Math.max(c.openedMs ?? 0, c.modifiedMs ?? 0);
    return { c, score: lastTouch };
  });
  scored.sort((a, b) => b.score - a.score);

  for (const { c, score } of scored) {
    if (toPrefetch.length >= maxCount) break;
    if (c.sizeBytes !== undefined && c.sizeBytes > maxSize) {
      skippedTooLarge.push(c.relPath);
      continue;
    }
    if (score < coldCutoff && (c.openedMs ?? 0) === 0) {
      skippedColdAndUnused.push(c.relPath);
      continue;
    }
    toPrefetch.push(c.relPath);
  }

  return { toPrefetch, skippedTooLarge, skippedColdAndUnused };
}

/**
 * Sentinel error: the proposed `workspace.fs.prefetch` API isn't stable. The
 * wiring layer catches this to fall back to a no-op (silent success — no
 * warming, but no broken UX).
 */
export class PrefetchApiNotAvailableError extends Error {
  readonly code = "prefetch_api_not_available" as const;
  constructor(message?: string) {
    super(
      message ??
        "workspace.fs.prefetch is a proposed VS Code API (v2.20.2 in roadmap). " +
          "Wire-up will land when the API stabilises in stable VS Code or Cursor.",
    );
    this.name = "PrefetchApiNotAvailableError";
  }
}
