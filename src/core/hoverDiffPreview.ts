/**
 * Hover Diff Preview — skeleton.
 *
 * Goal: when the user hovers a file decoration with `cloud_newer` status,
 * show a compact "diff summary" without downloading the full blob — only
 * the cheapest possible delta from `_meta.json` + cached local hash.
 *
 * The pure helper here computes the summary string from a precomputed
 * delta record. Wiring it to `vscode.languages.registerHoverProvider`
 * throws a sentinel.
 */

export class HoverDiffPreviewNotImplementedError extends Error {
  constructor(message = "Hover Diff Preview hover provider is not implemented yet") {
    super(message);
    this.name = "HoverDiffPreviewNotImplementedError";
  }
}

export interface HoverDiffSummaryInput {
  relPath: string;
  localHash: string | null;
  cloudHash: string;
  cloudSize: number;
  cloudUpdatedAtMs: number;
  cloudEditorMachine: string;
}

export function summariseHoverDiff(input: HoverDiffSummaryInput): string {
  if (input.localHash === input.cloudHash) {
    return `${input.relPath}: identical to cloud version.`;
  }
  const sizeKb = (input.cloudSize / 1024).toFixed(1);
  const ageMin = Math.max(Math.round((Date.now() - input.cloudUpdatedAtMs) / 60_000), 0);
  return `${input.relPath}: cloud is ${sizeKb} KB, edited by ${input.cloudEditorMachine} ~${String(ageMin)} min ago.`;
}

export function attachHoverProvider(): never {
  throw new HoverDiffPreviewNotImplementedError();
}
