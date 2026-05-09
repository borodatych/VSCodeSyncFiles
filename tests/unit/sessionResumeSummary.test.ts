/**
 * v2.6.7 — session resume summariser tests.
 */
import { describe, expect, it } from "vitest";
import {
  decideResumeAction,
  formatResumeSummaryMessage,
  summariseResumePlans,
} from "../../src/core/sessionResumeSummary.js";

describe("summariseResumePlans", () => {
  it("zeroes for empty input", () => {
    expect(summariseResumePlans([])).toEqual({ push: 0, pull: 0, conflict: 0 });
  });

  it("sums per-action across multiple plans", () => {
    const totals = summariseResumePlans([
      {
        files: [
          { action: "push" },
          { action: "push" },
          { action: "pull" },
          { action: "skip" },
        ],
      },
      {
        files: [
          { action: "conflict" },
          { action: "conflict_pending" },
          { action: "no_op" },
        ],
      },
    ]);
    expect(totals).toEqual({ push: 2, pull: 1, conflict: 2 });
  });

  it("ignores unknown actions", () => {
    const totals = summariseResumePlans([
      { files: [{ action: "weird_new_action" }, { action: "push" }] },
    ]);
    expect(totals).toEqual({ push: 1, pull: 0, conflict: 0 });
  });
});

describe("formatResumeSummaryMessage", () => {
  it("renders the three-line modal body with totals", () => {
    const msg = formatResumeSummaryMessage({ push: 5, pull: 3, conflict: 2 });
    expect(msg).toContain("пауза снята");
    expect(msg).toContain("↑ push 5");
    expect(msg).toContain("↓ pull 3");
    expect(msg).toContain("конфликты 2");
  });
});

describe("decideResumeAction", () => {
  it("aborts when no provider", () => {
    expect(decideResumeAction({ hasProvider: false, hasActiveRoot: true }))
      .toBe("abort_no_provider");
  });
  it("aborts when no active workspace root", () => {
    expect(decideResumeAction({ hasProvider: true, hasActiveRoot: false }))
      .toBe("abort_no_roots");
  });
  it("shows plan otherwise", () => {
    expect(decideResumeAction({ hasProvider: true, hasActiveRoot: true }))
      .toBe("show_plan");
  });
});
