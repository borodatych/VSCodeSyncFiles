import { describe, expect, it } from "vitest";
import { preserveConflictSharesLfCanonical } from "../../src/core/preserveLineEndingConflict.js";

describe("preserveConflictSharesLfCanonical", () => {
  const cfg = { lineEnding: "preserve" as const, encodingLint: true };

  it("returns true for same text CRLF local vs LF cloud", () => {
    const ok = preserveConflictSharesLfCanonical(Buffer.from("a\r\nb", "utf8"), Buffer.from("a\nb", "utf8"), "f.txt", cfg);
    expect(ok).toBe(true);
  });

  it("returns false when LF content differs", () => {
    const ok = preserveConflictSharesLfCanonical(Buffer.from("a\r\n", "utf8"), Buffer.from("b\n", "utf8"), "f.txt", cfg);
    expect(ok).toBe(false);
  });
});
