/**
 * v0.10 F-024 — pure prompt builder for "AI Explain Conflict".
 *
 * Asks the LM to produce a 2-3 sentence summary of *intent* differences
 * between LOCAL and REMOTE versions: not a merge, just "what was each
 * side trying to do?". Used as additional context in the Conflict
 * resolution UI before the user picks Keep Mine / Take Theirs / Keep Both.
 *
 * No `vscode` import. Caller wires this prompt to the LM session of
 * choice (Copilot LM, OpenAI-compatible endpoint, etc).
 */

const MAX_SNIPPET_CHARS = 3000; // ~750 tokens per side at 4 chars/token
const TOTAL_BUDGET_CHARS = 8000;

export interface ExplainConflictPromptInput {
  posixRel: string;
  localContent: string;
  remoteContent: string;
  /** Optional base content (`_meta.hash` ancestor) — when known, the LM
   *  can describe LOCAL/REMOTE intent relative to a common baseline. */
  baseContent?: string;
  /** Optional ISO timestamp of LAST sync to anchor the LM's time framing. */
  lastSyncIso?: string;
}

export interface ExplainConflictPrompt {
  /** System role message — sets tone + budget. */
  system: string;
  /** User role message with snippets. */
  user: string;
  /** Total approx token budget the caller should reserve for the response. */
  expectedResponseTokens: number;
}

/** Truncate a snippet to fit the budget, keeping head + tail context. */
function clip(content: string, max: number): string {
  if (content.length <= max) return content;
  // For very small budgets (< 80 chars) head/tail math collapses to slice(0)
  // — fall back to a plain head truncation. Defaults pass max >= 500 so this
  // path only fires under test or future tiny budgets.
  if (max < 80) {
    return `${content.slice(0, Math.max(0, max - 4))}...`;
  }
  const head = content.slice(0, Math.floor(max / 2) - 20);
  const tail = content.slice(-Math.floor(max / 2) + 20);
  return `${head}\n\n... (skipped ${String(content.length - max)} chars) ...\n\n${tail}`;
}

export function buildExplainConflictPrompt(input: ExplainConflictPromptInput): ExplainConflictPrompt {
  const localBudget = MAX_SNIPPET_CHARS;
  const remoteBudget = MAX_SNIPPET_CHARS;
  const baseBudget = input.baseContent === undefined
    ? 0
    : Math.max(500, TOTAL_BUDGET_CHARS - localBudget - remoteBudget);

  const local = clip(input.localContent, localBudget);
  const remote = clip(input.remoteContent, remoteBudget);
  const base = input.baseContent !== undefined ? clip(input.baseContent, baseBudget) : undefined;

  const system = [
    "You are reviewing a 3-way merge conflict for a developer.",
    "Output ONLY 2-3 short sentences (no bullet list, no code).",
    "Goal: explain INTENT of each side, not the textual diff.",
    "Format:",
    "  • LOCAL: one sentence about what the local change appears to be doing.",
    "  • REMOTE: one sentence about the remote change.",
    "  • (optional) one sentence with a recommendation: keep-mine / take-theirs / keep-both.",
    "Be specific. Avoid hedging like \"appears to be\". If both sides do the same thing, say so.",
  ].join("\n");

  const userParts: string[] = [];
  userParts.push(`File: ${input.posixRel}`);
  if (input.lastSyncIso) userParts.push(`Last successful sync: ${input.lastSyncIso}`);
  if (base !== undefined) {
    userParts.push("\n--- BASE (last synced version) ---");
    userParts.push(base);
  }
  userParts.push("\n--- LOCAL (your machine) ---");
  userParts.push(local);
  userParts.push("\n--- REMOTE (other machine) ---");
  userParts.push(remote);

  return {
    system,
    user: userParts.join("\n"),
    expectedResponseTokens: 200,
  };
}

/**
 * Strip leading bullet markers + collapse whitespace from an LM response
 * so the UI receives a clean line-broken summary suitable for InfoMessage.
 */
export function normaliseConflictExplanation(raw: string): string {
  return raw
    .replace(/^[\s•\-*]+/gm, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 5)
    .join("\n");
}
