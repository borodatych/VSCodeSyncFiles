import { describe, expect, it } from "vitest";
import { escapeHtml, joinClasses } from "../../src/core/htmlEscape.js";
import { renderQuotaDashboardHtml } from "../../src/core/quotaDashboardHtml.js";
import type { QuotaSnapshot } from "../../src/core/quotaTracker.js";

describe("escapeHtml", () => {
  it("escapes < > & ' \"", () => {
    expect(escapeHtml('<a href="x">A&B</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;A&amp;B&lt;/a&gt;",
    );
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("returns empty string on null / undefined", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("joinClasses", () => {
  it("filters out falsy values", () => {
    expect(joinClasses("a", false, null, undefined, "b")).toBe("a b");
  });

  it("collapses to empty string when all falsy", () => {
    expect(joinClasses(false, null, undefined)).toBe("");
  });
});

describe("renderQuotaDashboardHtml — empty state", () => {
  it("renders a description div when snapshots is empty", () => {
    const html = renderQuotaDashboardHtml([]);
    expect(html).toContain("vss-quota-empty");
    expect(html).toContain("No API calls recorded yet.");
  });

  it("uses custom empty message when provided", () => {
    const html = renderQuotaDashboardHtml([], { emptyMessage: "Nothing yet." });
    expect(html).toContain("Nothing yet.");
  });

  it("escapes user-controlled emptyMessage", () => {
    const html = renderQuotaDashboardHtml([], { emptyMessage: "<script>x</script>" });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("renderQuotaDashboardHtml — populated", () => {
  const snapshots: QuotaSnapshot[] = [
    {
      provider: "gdrive",
      callsInWindow: 700,
      dailyLimit: 1000,
      ratio: 0.7,
      severity: "warning",
    },
    {
      provider: "onedrive",
      callsInWindow: 5,
      dailyLimit: null,
      ratio: 0,
      severity: "ok",
    },
  ];

  it("renders one row per snapshot with bar width = ratio*100%", () => {
    const html = renderQuotaDashboardHtml(snapshots);
    expect(html).toContain("vss-quota-row");
    expect(html).toContain("width:70.0%");
    expect(html).toContain("700 / 1000");
    expect(html).toContain("no known limit");
  });

  it("applies severity class to the row", () => {
    const html = renderQuotaDashboardHtml(snapshots);
    expect(html).toContain("vss-sev-warning");
    expect(html).toContain("vss-sev-ok");
  });

  it("includes a <style> block referencing VS Code theme tokens", () => {
    const html = renderQuotaDashboardHtml(snapshots);
    expect(html).toContain("--vscode-foreground");
    expect(html).toContain("--vscode-progressBar-background");
  });

  it("does not exceed 100% width even when ratio reports > 1", () => {
    const overflowed: QuotaSnapshot[] = [
      { provider: "gdrive", callsInWindow: 9999, dailyLimit: 100, ratio: 99, severity: "auto_pause" },
    ];
    const html = renderQuotaDashboardHtml(overflowed);
    expect(html).toContain("width:100.0%");
  });
});
