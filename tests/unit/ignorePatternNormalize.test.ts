import { describe, expect, it } from "vitest";
import {
  normalizeIgnorePatternStrings,
  normalizeIgnorePatternLinesFromText,
} from "../../src/utils/ignorePatternNormalize.js";
import { parseIgnoreRules } from "../../src/utils/ignoreMatch.js";

describe("ignorePatternNormalize", () => {
  it("dedupes and skips comments/blank", () => {
    expect(
      normalizeIgnorePatternStrings(["a", "a", "  ", "#x", "b", "b"]),
    ).toEqual(["a", "b"]);
  });

  it("parse multiline text", () => {
    const s = " *.log \n\n#c\nfoo\n";
    expect(normalizeIgnorePatternLinesFromText(s)).toEqual(["*.log", "foo"]);
  });
});

describe("buildCombinedIgnore layering", () => {
  it("negation in later block can un-ignore from earlier", () => {
    const r = parseIgnoreRules("dist/\n!dist/keep.txt\n");
    expect(r.length).toBeGreaterThan(1);
  });
});
