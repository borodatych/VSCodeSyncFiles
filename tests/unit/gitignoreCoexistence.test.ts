import { describe, expect, it } from "vitest";
import {
  REQUIRED_GITIGNORE_ENTRIES,
  buildManagedBlock,
  detectMissingGitignoreEntries,
  ensureManagedBlock,
} from "../../src/core/gitignoreCoexistence.js";

describe("detectMissingGitignoreEntries", () => {
  it("empty .gitignore → block missing, all entries missing", () => {
    const r = detectMissingGitignoreEntries("");
    expect(r.blockPresent).toBe(false);
    expect(r.missingEntries).toEqual([...REQUIRED_GITIGNORE_ENTRIES]);
    expect(r.recommendation).toBe("insert");
  });

  it("manually-added entries → no block needed", () => {
    const content = REQUIRED_GITIGNORE_ENTRIES.join("\n");
    const r = detectMissingGitignoreEntries(content);
    expect(r.blockPresent).toBe(false);
    expect(r.missingEntries).toEqual([]);
    expect(r.recommendation).toBe("none");
  });

  it("complete managed block → recommendation=none", () => {
    const block = buildManagedBlock();
    const r = detectMissingGitignoreEntries(block);
    expect(r.blockPresent).toBe(true);
    expect(r.missingEntries).toEqual([]);
    expect(r.recommendation).toBe("none");
  });

  it("partial managed block → recommendation=repair", () => {
    const partial = [
      "# >>> VSCodeSync managed (do not edit between markers) >>>",
      ".vscode/vscodesync.json",
      "# <<< VSCodeSync managed <<<",
    ].join("\n");
    const r = detectMissingGitignoreEntries(partial);
    expect(r.blockPresent).toBe(true);
    expect(r.missingEntries.length).toBeGreaterThan(0);
    expect(r.recommendation).toBe("repair");
  });
});

describe("ensureManagedBlock", () => {
  it("appends block to empty .gitignore", () => {
    const out = ensureManagedBlock("");
    expect(out).toContain("# >>> VSCodeSync managed");
    expect(out).toContain(".vscode/vscodesync.json");
  });

  it("idempotent — full block stays unchanged", () => {
    const once = ensureManagedBlock("");
    const twice = ensureManagedBlock(once);
    expect(twice).toBe(once);
  });

  it("repairs a partial block", () => {
    const partial = [
      "node_modules/",
      "",
      "# >>> VSCodeSync managed (do not edit between markers) >>>",
      ".vscode/vscodesync.json",
      "# <<< VSCodeSync managed <<<",
    ].join("\n");
    const out = ensureManagedBlock(partial);
    expect(out).toContain(".vscode/vscodesync-local-backup/");
    expect(out).toContain("node_modules/");
  });

  it("preserves user content outside the block", () => {
    const content = "# my preamble\nnode_modules/\nbuild/\n";
    const out = ensureManagedBlock(content);
    expect(out.startsWith("# my preamble\nnode_modules/\nbuild/\n")).toBe(true);
  });
});
