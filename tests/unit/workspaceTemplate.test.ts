import { describe, it, expect } from "vitest";
import { parseWorkspaceTemplate, TemplateMarketplaceNotImplementedError } from "../../src/core/workspaceTemplate.js";

describe("parseWorkspaceTemplate", () => {
  const ok = {
    schema: 1,
    id: "vscodesync/typescript-monorepo",
    name: "TypeScript monorepo",
    description: "Default tracking for a TS monorepo with apps/ + packages/",
    defaultFilesGlob: ["apps/**/*.ts", "packages/**/*.ts"],
    ignorePatterns: ["node_modules/", "dist/"],
    recommendedExtensions: ["dbaeumer.vscode-eslint"],
  };

  it("accepts a minimal manifest", () => {
    const r = parseWorkspaceTemplate(ok);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.id).toBe(ok.id);
  });

  it("accepts optional welcomeMarkdown / tags / version", () => {
    const r = parseWorkspaceTemplate({
      ...ok,
      welcomeMarkdown: "# Welcome",
      tags: ["typescript"],
      version: "1.0.0",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.welcomeMarkdown).toBe("# Welcome");
      expect(r.manifest.tags).toEqual(["typescript"]);
      expect(r.manifest.version).toBe("1.0.0");
    }
  });

  it("rejects bad schema", () => {
    const r = parseWorkspaceTemplate({ ...ok, schema: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_schema");
  });

  it("rejects missing id", () => {
    const r = parseWorkspaceTemplate({ ...ok, id: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_id");
  });

  it("rejects non-array defaultFilesGlob", () => {
    const r = parseWorkspaceTemplate({ ...ok, defaultFilesGlob: "*.ts" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_default_files_glob");
  });

  it("rejects non-string element inside ignorePatterns", () => {
    const r = parseWorkspaceTemplate({ ...ok, ignorePatterns: ["dist/", 7] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_ignore_patterns");
  });

  it("rejects bad version type", () => {
    const r = parseWorkspaceTemplate({ ...ok, version: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_version");
  });

  it("rejects null / array / scalar root", () => {
    expect(parseWorkspaceTemplate(null).ok).toBe(false);
    expect(parseWorkspaceTemplate([]).ok).toBe(false);
    expect(parseWorkspaceTemplate("template").ok).toBe(false);
  });
});

describe("TemplateMarketplaceNotImplementedError", () => {
  it("carries the canonical code field", () => {
    const e = new TemplateMarketplaceNotImplementedError();
    expect(e.code).toBe("template_marketplace_not_implemented");
  });
});
