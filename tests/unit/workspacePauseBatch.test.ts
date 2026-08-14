import { describe, expect, it } from "vitest";
import { describePauseBatchOutcome } from "../../src/core/workspacePauseBatch.js";

describe("describePauseBatchOutcome", () => {
  it("reports a clean batch", () => {
    expect(describePauseBatchOutcome("suspend", { applied: 3, skipped: [] })).toBe(
      "VSCodeSync: приостановлено 3.",
    );
  });

  it("names what was skipped and why", () => {
    const text = describePauseBatchOutcome("resume", {
      applied: 1,
      skipped: [{ note: "Проект", reason: "сначала разархивируйте workspace" }],
    });
    expect(text).toContain("возобновлено 1");
    expect(text).toContain("Пропущено 1: Проект — сначала разархивируйте workspace");
  });

  it("truncates a long skip list instead of printing everything", () => {
    const text = describePauseBatchOutcome("suspend", {
      applied: 0,
      skipped: [1, 2, 3, 4, 5].map((n) => ({ note: `w${String(n)}`, reason: "нет" })),
    });
    expect(text).toContain("Пропущено 5");
    expect(text).toContain("+2");
  });
});
