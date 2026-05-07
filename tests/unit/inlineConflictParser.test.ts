/**
 * Unit tests for the conflict-marker scanner used by the inline CodeLens.
 * The scanner lives in a vscode-free module so we can test it directly.
 */
import { describe, it, expect } from "vitest";
import { scanConflictMarkers } from "../../src/ui/conflictMarkerScanner.js";

interface StubDoc {
  readonly lineCount: number;
  lineAt(i: number): { readonly text: string };
}

function doc(...lines: string[]): StubDoc {
  return {
    lineCount: lines.length,
    lineAt(i: number): { readonly text: string } {
      return { text: lines[i] ?? "" };
    },
  };
}

describe("scanConflictMarkers", () => {
  it("returns empty array when no markers", () => {
    expect(scanConflictMarkers(doc("a", "b", "c"))).toHaveLength(0);
  });

  it("detects one classic 2-way block", () => {
    const blocks = scanConflictMarkers(
      doc(
        "before",
        "<<<<<<< HEAD",
        "mine line",
        "=======",
        "their line",
        ">>>>>>> branch",
        "after",
      ),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[0].endLine).toBe(5);
  });

  it("detects diff3-style block with ||||||| base section", () => {
    const blocks = scanConflictMarkers(
      doc(
        "<<<<<<< ours",
        "mine line",
        "||||||| base",
        "base line",
        "=======",
        "their line",
        ">>>>>>> theirs",
      ),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startLine).toBe(0);
    expect(blocks[0].endLine).toBe(6);
  });

  it("detects multiple non-overlapping blocks", () => {
    const blocks = scanConflictMarkers(
      doc(
        "<<<<<<< HEAD",
        "a",
        "=======",
        "b",
        ">>>>>>> branch",
        "between",
        "<<<<<<< HEAD",
        "c",
        "=======",
        "d",
        ">>>>>>> other",
      ),
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].startLine).toBe(0);
    expect(blocks[1].startLine).toBe(6);
  });

  it("ignores incomplete block (head without tail)", () => {
    expect(
      scanConflictMarkers(doc("<<<<<<< HEAD", "mine", "=======", "their", "no tail here")),
    ).toHaveLength(0);
  });

  it("ignores tail without preceding ======= separator", () => {
    expect(
      scanConflictMarkers(doc("<<<<<<< HEAD", "mine", ">>>>>>> branch")),
    ).toHaveLength(0);
  });

  it("does not match lines that merely contain '<<<<<<<' inside text", () => {
    expect(
      scanConflictMarkers(
        doc(
          "// comment with <<<<<<< inside, not a marker",
          "code line",
          "// another >>>>>>>",
        ),
      ),
    ).toHaveLength(0);
  });
});
