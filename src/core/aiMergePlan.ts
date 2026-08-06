/**
 * Pure part of the AI-merge apply step (D5).
 *
 * The model's answer used to be written straight over the user's file. It now
 * lands in a preview file next to the local backups, and the user decides after
 * seeing a diff — so the two things worth computing without touching disk are
 * where that preview lives and what the change amounts to.
 */
import * as path from "node:path";

/**
 * Staging path for the model output: inside the local-backup dir, so it shares
 * the workspace's ignore rules and never lands in the tracked tree itself.
 * The basename keeps the original extension so the diff view highlights it.
 */
export function aiMergePreviewPath(
  workspaceRoot: string,
  backupDir: string,
  posixRel: string,
  nowMs: number,
): string {
  const stamp = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  const base = posixRel.split("/").pop() ?? "merged";
  const ext = path.extname(base);
  const stem = ext === "" ? base : base.slice(0, -ext.length);
  return path.join(workspaceRoot, backupDir, ".ai-merge", `${stem}.ai-${stamp}${ext}`);
}

export interface AiMergeDiffSummary {
  addedLines: number;
  removedLines: number;
  /** `true` when the model returned exactly the local content. */
  identical: boolean;
}

/**
 * Line-level size of the change, for the confirmation prompt. This is a
 * multiset difference, not a diff algorithm: moved lines count as neither
 * added nor removed, which is what a "how much changes" number should say.
 */
export function summarizeAiMergeDiff(localText: string, mergedText: string): AiMergeDiffSummary {
  if (localText === mergedText) {
    return { addedLines: 0, removedLines: 0, identical: true };
  }
  const counts = new Map<string, number>();
  for (const line of localText.split("\n")) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let addedLines = 0;
  for (const line of mergedText.split("\n")) {
    const left = counts.get(line) ?? 0;
    if (left > 0) {
      counts.set(line, left - 1);
    } else {
      addedLines += 1;
    }
  }
  let removedLines = 0;
  for (const left of counts.values()) {
    removedLines += left;
  }
  return { addedLines, removedLines, identical: false };
}
