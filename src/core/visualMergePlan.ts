/**
 * v3.G — pure planner for the visual 3-way merger UI.
 *
 * No `vscode` import. Operates on plain string arrays of lines.
 *
 * Output:
 *   - `MergeHunk[]`: each hunk records the base/local/cloud regions and the
 *     hunk's classification (clean / conflict / additionLocal / additionCloud).
 *   - `applyHunkChoices(...)`: pick `mine` / `theirs` / `merged` per hunk and
 *     materialise the resulting lines.
 *
 * Algorithm: simple line-by-line LCS-free 3-way diff: walk the three buffers
 * in parallel. Where local + cloud agree, emit clean; where they disagree
 * relative to base, emit conflict. This is intentionally not a Myers/LCS
 * implementation — for the UI's purpose, hunks scoped tightly enough to a
 * conflicting region is good enough; the user picks per-hunk.
 */

export type HunkKind =
  | "clean"
  | "conflict"
  | "addition_local"
  | "addition_cloud"
  | "deletion_local"
  | "deletion_cloud";

export interface MergeHunk {
  index: number;
  kind: HunkKind;
  base: string[];
  local: string[];
  cloud: string[];
  /** Default selection for clean hunks (auto), undefined for conflict (user picks). */
  defaultChoice?: "mine" | "theirs";
}

export type HunkChoice = "mine" | "theirs" | "merged";

export interface MergeBuildPlan {
  hunks: MergeHunk[];
  /** Total number of conflict hunks the user must resolve. */
  conflictCount: number;
}

export function buildMergePlan(base: string[], local: string[], cloud: string[]): MergeBuildPlan {
  const hunks: MergeHunk[] = [];
  let bi = 0;
  let li = 0;
  let ci = 0;

  while (bi < base.length || li < local.length || ci < cloud.length) {
    // Common prefix where all three agree.
    if (
      bi < base.length &&
      li < local.length &&
      ci < cloud.length &&
      base[bi] === local[li] &&
      base[bi] === cloud[ci]
    ) {
      const startB = bi;
      const startL = li;
      const startC = ci;
      while (
        bi < base.length &&
        li < local.length &&
        ci < cloud.length &&
        base[bi] === local[li] &&
        base[bi] === cloud[ci]
      ) {
        bi += 1;
        li += 1;
        ci += 1;
      }
      hunks.push({
        index: hunks.length,
        kind: "clean",
        base: base.slice(startB, bi),
        local: local.slice(startL, li),
        cloud: cloud.slice(startC, ci),
      });
      continue;
    }

    // Disagreement region: skip until we re-converge on a 3-way match.
    const startB = bi;
    const startL = li;
    const startC = ci;
    let advanced = false;
    while (bi < base.length || li < local.length || ci < cloud.length) {
      if (
        bi < base.length &&
        li < local.length &&
        ci < cloud.length &&
        base[bi] === local[li] &&
        base[bi] === cloud[ci]
      ) {
        break;
      }
      if (bi < base.length) bi += 1;
      if (li < local.length) li += 1;
      if (ci < cloud.length) ci += 1;
      advanced = true;
    }
    if (!advanced) break; // safety
    const localLines = local.slice(startL, li);
    const cloudLines = cloud.slice(startC, ci);
    const baseLines = base.slice(startB, bi);
    hunks.push({
      index: hunks.length,
      kind: classifyHunk(baseLines, localLines, cloudLines),
      base: baseLines,
      local: localLines,
      cloud: cloudLines,
    });
  }

  let conflictCount = 0;
  for (const h of hunks) {
    if (h.kind === "conflict") conflictCount += 1;
  }
  return { hunks, conflictCount };
}

function classifyHunk(base: string[], local: string[], cloud: string[]): HunkKind {
  const localChanged = !arraysEqual(base, local);
  const cloudChanged = !arraysEqual(base, cloud);
  if (localChanged && cloudChanged) {
    if (arraysEqual(local, cloud)) return "clean"; // both made the same change
    return "conflict";
  }
  if (localChanged && cloud.length === base.length) return "addition_local";
  if (cloudChanged && local.length === base.length) return "addition_cloud";
  if (localChanged) return local.length === 0 ? "deletion_local" : "addition_local";
  if (cloudChanged) return cloud.length === 0 ? "deletion_cloud" : "addition_cloud";
  return "clean";
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Materialise the merged result given the user's per-hunk picks. For
 * clean hunks the choice is ignored (always uses base). For conflict /
 * addition / deletion: the named branch wins. */
export function applyHunkChoices(
  hunks: MergeHunk[],
  choices: Partial<Record<number, HunkChoice>>,
  customMerged?: Partial<Record<number, string[]>>,
): string[] {
  const out: string[] = [];
  for (const h of hunks) {
    if (h.kind === "clean") {
      out.push(...h.base);
      continue;
    }
    const choice = choices[h.index] ?? "mine";
    if (choice === "merged") {
      const cm = customMerged?.[h.index] ?? h.local;
      out.push(...cm);
      continue;
    }
    out.push(...(choice === "mine" ? h.local : h.cloud));
  }
  return out;
}
