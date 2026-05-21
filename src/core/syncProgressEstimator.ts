/**
 * v0.16 N11 — pure ETA estimator for `vscode.window.withProgress`.
 *
 * Given a moving window of last-N file completions, predict remaining
 * time. Used by the engine's pushAll / pullAll wrapper to render
 * "Sync 12/47 (eta 0:15)" without coupling to a clock library.
 */

export interface ProgressSample {
  /** Completed file index at sample time. */
  done: number;
  /** Wall-clock ms when sample was taken. */
  atMs: number;
}

export interface ProgressEstimate {
  /** Files left. */
  remaining: number;
  /** Estimated milliseconds left. -1 when not yet predictable. */
  etaMs: number;
  /** Human-readable label like "0:15" / "2m 30s". */
  etaLabel: string;
}

export class SyncProgressEstimator {
  private readonly samples: ProgressSample[] = [];
  /** Maximum recent samples kept; older drop off. */
  private readonly window = 20;
  constructor(public readonly total: number) {}

  /** Record a completion event. */
  note(done: number, atMs: number = Date.now()): void {
    this.samples.push({ done, atMs });
    if (this.samples.length > this.window) this.samples.shift();
  }

  estimate(atMs: number = Date.now()): ProgressEstimate {
    if (this.samples.length < 2) {
      const done = this.samples.length === 0 ? 0 : this.samples[this.samples.length - 1].done;
      const remaining = Math.max(0, this.total - done);
      return { remaining, etaMs: -1, etaLabel: remaining === 0 ? "done" : "?" };
    }
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const remaining = Math.max(0, this.total - last.done);
    if (remaining === 0) {
      return { remaining: 0, etaMs: -1, etaLabel: "done" };
    }
    const elapsed = last.atMs - first.atMs;
    const completedInWindow = last.done - first.done;
    if (completedInWindow <= 0 || elapsed <= 0) {
      // No measurable progress; check whether we've idled for >2s and extend window.
      const idleMs = atMs - last.atMs;
      if (idleMs > 5_000) {
        return { remaining, etaMs: -1, etaLabel: "stalled" };
      }
      return { remaining, etaMs: -1, etaLabel: "?" };
    }
    const msPerFile = elapsed / completedInWindow;
    const etaMs = Math.max(0, Math.floor(msPerFile * remaining));
    return { remaining, etaMs, etaLabel: formatEta(etaMs) };
  }
}

/** Format ms as "0:15" / "2m 30s" / "1h 5m". Pure. */
export function formatEta(ms: number): string {
  if (ms < 0) return "?";
  if (ms < 1000) return "<1s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${String(totalSec)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${String(min)}m ${String(sec).padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${String(hr)}h ${String(remMin).padStart(2, "0")}m`;
}
