import { describe, expect, it } from "vitest";
import {
  buildReleaseNotes,
  formatReleaseNotesMarkdown,
} from "../../src/core/workspaceReleaseNotes.js";

describe("buildReleaseNotes", () => {
  it("classifies added / modified / removed", () => {
    const r = buildReleaseNotes({
      fromFiles: [
        { path: "a.ts", version: 1 },
        { path: "b.ts", version: 1 },
        { path: "removed.ts", version: 1 },
      ],
      toFiles: [
        { path: "a.ts", version: 1 },       // unchanged
        { path: "b.ts", version: 2 },       // modified
        { path: "new.ts", version: 1 },     // added
      ],
    });
    expect(r.added).toEqual(["new.ts"]);
    expect(r.modified).toEqual(["b.ts"]);
    expect(r.removed).toEqual(["removed.ts"]);
    expect(r.netDelta).toBe(0); // -1 + 1
  });

  it("identical snapshots → no changes", () => {
    const same = [{ path: "a", version: 1 }];
    const r = buildReleaseNotes({ fromFiles: same, toFiles: same });
    expect(r.added.length).toBe(0);
    expect(r.modified.length).toBe(0);
    expect(r.removed.length).toBe(0);
  });

  it("sorts each list alphabetically", () => {
    const r = buildReleaseNotes({
      fromFiles: [],
      toFiles: [
        { path: "z.ts", version: 1 },
        { path: "a.ts", version: 1 },
        { path: "m.ts", version: 1 },
      ],
    });
    expect(r.added).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});

describe("formatReleaseNotesMarkdown", () => {
  it("contains all sections when populated", () => {
    const r = buildReleaseNotes({
      fromFiles: [{ path: "x", version: 1 }, { path: "gone", version: 1 }],
      toFiles: [{ path: "y", version: 1 }, { path: "x", version: 2 }],
    });
    const md = formatReleaseNotesMarkdown(r, { fromFiles: [], toFiles: [], fromTag: "v1", toTag: "v2" });
    expect(md).toContain("v1 → v2");
    expect(md).toContain("## Added");
    expect(md).toContain("## Modified");
    expect(md).toContain("## Removed");
  });

  it("notes empty when no changes", () => {
    const r = buildReleaseNotes({ fromFiles: [], toFiles: [] });
    const md = formatReleaseNotesMarkdown(r, { fromFiles: [], toFiles: [] });
    expect(md).toContain("no changes");
  });
});
