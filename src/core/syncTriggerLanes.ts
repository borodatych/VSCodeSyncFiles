/**
 * Two serialised lanes for automatic sync triggers. Pure — no `vscode`, no I/O.
 *
 * Every trigger used to share one promise chain built as `chain.then(fn, fn)`.
 * That guards against a step *rejecting* but not against a step that never
 * settles, and it made unrelated work compete: a full pass over every workspace
 * blocked the quick per-file push queued right after a save. One wedged step
 * froze every later trigger for the lifetime of the window.
 *
 * - `file` — per-file push/pull. Serialised, order preserved.
 * - `full` — whole-workspace passes. Serialised *and collapsing*: while one is
 *   queued or running, further requests are dropped rather than stacked. Ten
 *   window-focus events in a row should mean one sync, not ten.
 *
 * Every step runs under a deadline. On expiry the lane is released and the step
 * is abandoned — it may still be running, but it can no longer block the lane.
 */

export type TriggerLane = "file" | "full";

export interface TriggerLanesOptions {
  /** Per-step deadline in ms. 0 disables it. */
  stepTimeoutMs?: number;
  /** Called when a step outlives the deadline and its lane is released. */
  onStepTimeout?: (label: string, timeoutMs: number) => void;
  /** Called when a step rejects. Rejections never break the lane. */
  onStepError?: (label: string, error: unknown) => void;
  /** Called when a `full` request is dropped because one is already pending. */
  onFullSkipped?: (label: string) => void;
}

export interface TriggerLanes {
  /** Queue `fn` on `lane`. Never throws; failures are reported through callbacks. */
  run(lane: TriggerLane, fn: () => Promise<void>, label: string): void;
  /** Resolves once both lanes have drained everything queued so far. */
  idle(): Promise<void>;
  /** How many `full` requests were collapsed into an already-pending one. */
  readonly skippedFullCount: number;
  /** How many steps were abandoned by the deadline. */
  readonly timedOutCount: number;
}

export const DEFAULT_TRIGGER_STEP_TIMEOUT_MS = 6 * 60_000;

export function createTriggerLanes(opts: TriggerLanesOptions = {}): TriggerLanes {
  const stepTimeoutMs = opts.stepTimeoutMs ?? DEFAULT_TRIGGER_STEP_TIMEOUT_MS;
  const lanes: Record<TriggerLane, Promise<void>> = {
    file: Promise.resolve(),
    full: Promise.resolve(),
  };
  let fullPending = false;
  let skippedFull = 0;
  let timedOut = 0;

  const guarded = (fn: () => Promise<void>, label: string): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      const timer =
        stepTimeoutMs > 0
          ? setTimeout(() => {
              if (settled) return;
              timedOut += 1;
              opts.onStepTimeout?.(label, stepTimeoutMs);
              finish();
            }, stepTimeoutMs)
          : undefined;

      let started: Promise<void>;
      try {
        started = fn();
      } catch (e: unknown) {
        opts.onStepError?.(label, e);
        finish();
        return;
      }
      started.then(finish, (e: unknown) => {
        opts.onStepError?.(label, e);
        finish();
      });
    });

  return {
    run(lane: TriggerLane, fn: () => Promise<void>, label: string): void {
      if (lane === "full") {
        if (fullPending) {
          skippedFull += 1;
          opts.onFullSkipped?.(label);
          return;
        }
        fullPending = true;
        lanes.full = lanes.full
          .then(() => guarded(fn, label))
          .then(() => {
            fullPending = false;
          });
        return;
      }
      lanes.file = lanes.file.then(() => guarded(fn, label));
    },
    async idle(): Promise<void> {
      // Two rounds: a step queued by another step is picked up by the second.
      await Promise.all([lanes.file, lanes.full]);
      await Promise.all([lanes.file, lanes.full]);
    },
    get skippedFullCount(): number {
      return skippedFull;
    },
    get timedOutCount(): number {
      return timedOut;
    },
  };
}
