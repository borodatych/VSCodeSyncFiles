/**
 * Pure conflict-marker scanner — vscode-free so it can be unit-tested.
 *
 * Detects git-style conflict blocks:
 *   <<<<<<< (mine|HEAD)
 *   …
 *   ||||||| base    (diff3 only, optional)
 *   …
 *   =======
 *   …
 *   >>>>>>> (theirs)
 *
 * Markers must start at column 0 and use the literal seven-character form;
 * lines that merely contain the marker substring inside text are ignored.
 * The scanner walks the document once; any incomplete block (head without
 * separator + tail) is silently skipped.
 */

const HEAD_MARKER = /^<{7} /;
const MIDDLE_MARKER = /^={7}$/;
const BASE_MARKER = /^\|{7} /;
const TAIL_MARKER = /^>{7} /;

export interface ConflictBlockSpan {
  /** Line number of the `<<<<<<<` marker (0-based). */
  startLine: number;
  /** Line number of the `>>>>>>>` marker (0-based, inclusive). */
  endLine: number;
}

export interface ScannableLines {
  readonly lineCount: number;
  lineAt(i: number): { readonly text: string };
}

export function scanConflictMarkers(doc: ScannableLines): ConflictBlockSpan[] {
  const blocks: ConflictBlockSpan[] = [];
  let head = -1;
  let sawMiddle = false;
  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    if (HEAD_MARKER.test(text)) {
      head = line;
      sawMiddle = false;
      continue;
    }
    if (head === -1) continue;
    if (BASE_MARKER.test(text)) {
      // diff3-style base section — keep the block alive, ignore the marker
      continue;
    }
    if (MIDDLE_MARKER.test(text)) {
      sawMiddle = true;
      continue;
    }
    if (TAIL_MARKER.test(text)) {
      if (sawMiddle) {
        blocks.push({ startLine: head, endLine: line });
      }
      head = -1;
      sawMiddle = false;
    }
  }
  return blocks;
}
