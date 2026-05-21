import { describe, expect, it } from "vitest";
import {
  buildExplainConflictPrompt,
  normaliseConflictExplanation,
} from "../../src/core/aiExplainConflictPrompt.js";

describe("buildExplainConflictPrompt", () => {
  it("includes file path and both sides", () => {
    const p = buildExplainConflictPrompt({
      posixRel: "src/x.ts",
      localContent: "console.log('hello')",
      remoteContent: "console.error('goodbye')",
    });
    expect(p.user).toContain("src/x.ts");
    expect(p.user).toContain("LOCAL");
    expect(p.user).toContain("REMOTE");
    expect(p.user).toContain("hello");
    expect(p.user).toContain("goodbye");
  });

  it("system message commits to 2-3 sentences", () => {
    const p = buildExplainConflictPrompt({
      posixRel: "x",
      localContent: "a",
      remoteContent: "b",
    });
    expect(p.system).toContain("2-3 short sentences");
    expect(p.system).toContain("INTENT");
  });

  it("includes base when provided", () => {
    const p = buildExplainConflictPrompt({
      posixRel: "x",
      localContent: "a",
      remoteContent: "b",
      baseContent: "common ancestor here",
    });
    expect(p.user).toContain("BASE");
    expect(p.user).toContain("common ancestor");
  });

  it("clips snippets that exceed budget", () => {
    const huge = "x".repeat(10_000);
    const p = buildExplainConflictPrompt({
      posixRel: "x",
      localContent: huge,
      remoteContent: huge,
    });
    expect(p.user).toContain("skipped");
    expect(p.user.length).toBeLessThan(15_000);
  });

  it("lastSyncIso appears when set", () => {
    const p = buildExplainConflictPrompt({
      posixRel: "x",
      localContent: "a",
      remoteContent: "b",
      lastSyncIso: "2026-05-21T00:00:00Z",
    });
    expect(p.user).toContain("2026-05-21");
  });
});

describe("normaliseConflictExplanation", () => {
  it("strips leading bullets and trims", () => {
    const raw = "• LOCAL: adds logging\n  - REMOTE: renames variable\n\n* recommendation: keep-mine";
    const out = normaliseConflictExplanation(raw);
    expect(out).toContain("LOCAL: adds logging");
    expect(out).not.toMatch(/^[•*-]/m);
  });

  it("caps to 5 lines", () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line ${String(i + 1)}`).join("\n");
    const lines = normaliseConflictExplanation(raw).split("\n");
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("collapses blank lines", () => {
    const out = normaliseConflictExplanation("a\n\n\n\nb");
    expect(out).toBe("a\nb");
  });
});
