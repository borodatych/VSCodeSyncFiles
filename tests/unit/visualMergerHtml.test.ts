import { describe, expect, it } from "vitest";
import { buildMergePlan } from "../../src/core/visualMergePlan.js";
import { renderVisualMergerHtml } from "../../src/core/visualMergerHtml.js";

describe("renderVisualMergerHtml — empty / clean cases", () => {
  it("renders the title and 0 conflicts when buffers are identical", () => {
    const plan = buildMergePlan(["a", "b"], ["a", "b"], ["a", "b"]);
    const html = renderVisualMergerHtml(plan.hunks);
    expect(html).toContain("Visual 3-way merge");
    expect(html).toContain("0 conflicts");
    expect(html).toContain("vss-hunk-clean");
  });

  it("renders the column headers", () => {
    const html = renderVisualMergerHtml([]);
    expect(html).toContain("Base");
    expect(html).toContain("Local (mine)");
    expect(html).toContain("Cloud (theirs)");
  });
});

describe("renderVisualMergerHtml — conflict cases", () => {
  const plan = buildMergePlan(
    ["a", "x", "c"],
    ["a", "MINE", "c"],
    ["a", "THEIRS", "c"],
  );

  it("renders radio inputs for conflict hunks (default mine checked)", () => {
    const html = renderVisualMergerHtml(plan.hunks);
    expect(html).toContain('type="radio"');
    expect(html).toContain('value="mine" checked');
    expect(html).toContain('value="theirs"');
    expect(html).toContain('value="merged"');
  });

  it("respects pre-set choices", () => {
    const conflictIdx = plan.hunks.find((h) => h.kind === "conflict")?.index;
    if (conflictIdx === undefined) throw new Error("expected a conflict hunk");
    const html = renderVisualMergerHtml(plan.hunks, {
      choices: { [conflictIdx]: "theirs" },
    });
    expect(html).toContain('value="theirs" checked');
    expect(html).not.toContain('value="mine" checked');
  });

  it("displays the local and cloud lines escaped", () => {
    const escapedPlan = buildMergePlan(
      ["base"],
      ["<script>alert('x')</script>"],
      ["clean"],
    );
    const html = renderVisualMergerHtml(escapedPlan.hunks);
    expect(html).not.toContain("<script>alert('x')</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderVisualMergerHtml — addition / deletion auto labels", () => {
  it("addition_local hunk shows '+ added locally'", () => {
    const plan = buildMergePlan(["a", "c"], ["a", "b", "c"], ["a", "c"]);
    const html = renderVisualMergerHtml(plan.hunks);
    expect(html).toContain("+ added locally");
  });

  it("addition_cloud hunk shows '+ added on cloud'", () => {
    const plan = buildMergePlan(["a", "c"], ["a", "c"], ["a", "b", "c"]);
    const html = renderVisualMergerHtml(plan.hunks);
    expect(html).toContain("+ added on cloud");
  });
});

describe("renderVisualMergerHtml — title customisation", () => {
  it("uses caller-supplied title when provided", () => {
    const html = renderVisualMergerHtml([], { title: "Resolve auth.ts" });
    expect(html).toContain("Resolve auth.ts");
  });

  it("escapes a malicious title", () => {
    const html = renderVisualMergerHtml([], { title: "<img src=x onerror=alert(1) />" });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});
