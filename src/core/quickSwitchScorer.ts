/**
 * v0.14 F-064 — pure scorer for the Quick Switch workspace picker.
 *
 * Inputs:
 *   - list of workspaces (id, note, tags, lastSyncMs, fileCount, syncState, pinned)
 *   - optional typeahead filter string
 *   - optional pinned set (user explicit favourites)
 * Output:
 *   - ordered list ready for `vscode.window.showQuickPick`
 *   - per-item sparkline (24h activity bucketing)
 *   - matchedTags / score for diagnostics
 *
 * Sort priority:
 *   1. pinned (user-tagged favourites)
 *   2. activeWorkspaces with recent sync (lastSyncMs within 24h)
 *   3. activeWorkspaces by lastSyncMs desc
 *   4. suspended workspaces
 *   5. archived/frozen — last
 */

export type WorkspaceLifecycleState = "active" | "suspended" | "frozen" | "archived";

export interface QuickSwitchWorkspace {
  workspaceId: string;
  workspaceNote: string;
  tags?: readonly string[];
  /** ms timestamp of newest tracked-file sync; 0 means "never". */
  lastSyncMs: number;
  fileCount: number;
  state: WorkspaceLifecycleState;
  /** Per-hour activity counts for the last 24h (oldest first). */
  hourlyCounts?: readonly number[];
}

export interface QuickSwitchItem {
  workspaceId: string;
  label: string;
  description: string;
  detail: string;
  /** Inline sparkline using block characters. Empty if no activity data. */
  sparkline: string;
  /** Sort score for diagnostics. */
  score: number;
}

export interface QuickSwitchOptions {
  /** Typeahead substring filter (case-insensitive). Filters by note + tags. */
  filter?: string;
  /** ids that the user has pinned. Always rise to the top. */
  pinned?: ReadonlySet<string>;
  /** Wall-clock now. */
  nowMs?: number;
}

const DAY_MS = 86_400_000;

const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Render 24 hourly counts as an 8-block sparkline. */
export function renderSparkline(hourly: readonly number[] | undefined): string {
  if (!hourly || hourly.length === 0) return "";
  const max = Math.max(...hourly);
  if (max === 0) return (BLOCKS[0] ?? " ").repeat(hourly.length);
  return hourly
    .map((n) => {
      const ratio = Math.min(1, n / max);
      const idx = Math.round(ratio * (BLOCKS.length - 1));
      return BLOCKS[idx] ?? " ";
    })
    .join("");
}

function matchesFilter(ws: QuickSwitchWorkspace, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (ws.workspaceNote.toLowerCase().includes(needle)) return true;
  for (const t of ws.tags ?? []) {
    if (t.toLowerCase().includes(needle)) return true;
  }
  return ws.workspaceId.toLowerCase().includes(needle);
}

function statePriority(state: WorkspaceLifecycleState): number {
  switch (state) {
    case "active": return 3;
    case "suspended": return 2;
    case "frozen": return 1;
    case "archived": return 0;
  }
}

function computeScore(
  ws: QuickSwitchWorkspace,
  nowMs: number,
  pinned: ReadonlySet<string>,
): number {
  let score = 0;
  if (pinned.has(ws.workspaceId)) score += 100_000;
  score += statePriority(ws.state) * 1_000;
  if (ws.lastSyncMs > 0) {
    const ageDays = (nowMs - ws.lastSyncMs) / DAY_MS;
    if (ageDays < 1) score += 500;
    score += Math.max(0, 100 - Math.floor(ageDays));
  }
  return score;
}

function formatDetail(ws: QuickSwitchWorkspace, nowMs: number): string {
  const parts: string[] = [];
  parts.push(`${String(ws.fileCount)} файлов`);
  if (ws.lastSyncMs > 0) {
    const ageMs = nowMs - ws.lastSyncMs;
    const days = Math.floor(ageMs / DAY_MS);
    const hours = Math.floor((ageMs % DAY_MS) / 3_600_000);
    if (days === 0 && hours === 0) parts.push("синк только что");
    else if (days === 0) parts.push(`${String(hours)}ч назад`);
    else if (days < 7) parts.push(`${String(days)}д назад`);
    else parts.push(`${String(Math.floor(days / 7))}нед назад`);
  } else {
    parts.push("никогда не синкался");
  }
  if (ws.tags && ws.tags.length > 0) parts.push(ws.tags.slice(0, 3).join(", "));
  if (ws.state !== "active") parts.push(`[${ws.state}]`);
  return parts.join(" · ");
}

export function buildQuickSwitchItems(
  workspaces: readonly QuickSwitchWorkspace[],
  opts: QuickSwitchOptions = {},
): QuickSwitchItem[] {
  const nowMs = opts.nowMs ?? Date.now();
  const pinned = opts.pinned ?? new Set<string>();
  const filtered = opts.filter && opts.filter.length > 0
    ? workspaces.filter((w) => matchesFilter(w, opts.filter ?? ""))
    : workspaces.slice();
  const scored: QuickSwitchItem[] = filtered.map((ws) => {
    const score = computeScore(ws, nowMs, pinned);
    const sparkline = renderSparkline(ws.hourlyCounts);
    const pinMarker = pinned.has(ws.workspaceId) ? "★ " : "";
    return {
      workspaceId: ws.workspaceId,
      label: `${pinMarker}${ws.workspaceNote || ws.workspaceId}`,
      description: sparkline ? ` ${sparkline}` : "",
      detail: formatDetail(ws, nowMs),
      sparkline,
      score,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
