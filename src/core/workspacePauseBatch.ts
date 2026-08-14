/**
 * Wording for the batch pause/resume commands.
 *
 * Pure: the commands do the picking and the engine calls, this module owns the
 * one thing that is easy to get wrong and worth a test — reporting partial
 * outcomes honestly. A batch that half-worked must say so, not print a cheerful
 * total that hides the workspaces the state machine refused.
 */

export interface PauseBatchOutcome {
  applied: number;
  /** Workspaces the state machine refused, with its reason. */
  skipped: { note: string; reason: string }[];
}

export function describePauseBatchOutcome(
  action: "suspend" | "resume",
  outcome: PauseBatchOutcome,
): string {
  const verb = action === "suspend" ? "приостановлено" : "возобновлено";
  const head = `VSCodeSync: ${verb} ${String(outcome.applied)}.`;
  if (outcome.skipped.length === 0) {
    return head;
  }
  const shown = outcome.skipped
    .slice(0, 3)
    .map((s) => `${s.note} — ${s.reason}`)
    .join("; ");
  const tail = outcome.skipped.length > 3 ? ` … +${String(outcome.skipped.length - 3)}` : "";
  return `${head} Пропущено ${String(outcome.skipped.length)}: ${shown}${tail}`;
}
