/**
 * Tests for the `.vscodesync-readme.md` welcome renderer (v2.20.5).
 */
import { describe, it, expect } from "vitest";
import { renderWorkspaceReadmeHtml } from "../../src/core/workspaceReadmeMd.js";

describe("renderWorkspaceReadmeHtml", () => {
  it("renders headings, paragraphs, and bullet lists", () => {
    const md = "# Hello\n\nIntro text.\n\n## Items\n\n- One\n- Two\n";
    const html = renderWorkspaceReadmeHtml(md);
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<p>Intro text.</p>");
    expect(html).toContain("<h2>Items</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>One</li>");
    expect(html).toContain("<li>Two</li>");
  });

  it("supports inline bold / italic / code", () => {
    const md = "Some **bold** and *italic* and `code` text.";
    const html = renderWorkspaceReadmeHtml(md);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders http(s) links and drops other schemes", () => {
    const safe = renderWorkspaceReadmeHtml("[ok](https://example.com)");
    expect(safe).toContain('<a href="https://example.com">ok</a>');
    const unsafe = renderWorkspaceReadmeHtml("[boom](javascript:alert(1))");
    expect(unsafe).not.toContain("<a");
    expect(unsafe).toContain("[boom](javascript:alert(1))");
  });

  it("escapes HTML in arbitrary content", () => {
    const html = renderWorkspaceReadmeHtml("paragraph with <script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });

  it("uses workspaceLabel in the document title when provided", () => {
    const html = renderWorkspaceReadmeHtml("# Body", { workspaceLabel: "MyProject" });
    expect(html).toContain("Workspace: MyProject");
  });

  it("falls back to the configured title when no label", () => {
    const html = renderWorkspaceReadmeHtml("# Body", { fallbackTitle: "Welcome" });
    expect(html).toContain("Welcome");
  });
});
