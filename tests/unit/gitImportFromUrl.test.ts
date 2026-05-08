import { describe, expect, it } from "vitest";
import {
  parseRepoUrl,
  planImportFromGit,
} from "../../src/core/gitImportFromUrl.js";

describe("parseRepoUrl", () => {
  it("parses HTTPS GitHub URLs with .git suffix", () => {
    const r = parseRepoUrl("https://github.com/borodatych/VSCodeSyncFiles.git");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.host).toBe("github.com");
      expect(r.parsed.owner).toBe("borodatych");
      expect(r.parsed.repo).toBe("VSCodeSyncFiles");
      expect(r.parsed.suggestedFolderName).toBe("VSCodeSyncFiles");
    }
  });

  it("parses HTTPS GitLab URLs without .git suffix", () => {
    const r = parseRepoUrl("https://gitlab.com/group/project");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.host).toBe("gitlab.com");
      expect(r.parsed.owner).toBe("group");
      expect(r.parsed.repo).toBe("project");
    }
  });

  it("parses SSH-form URLs", () => {
    const r = parseRepoUrl("git@github.com:owner/repo.git");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.host).toBe("github.com");
      expect(r.parsed.owner).toBe("owner");
      expect(r.parsed.repo).toBe("repo");
    }
  });

  it("rejects empty input", () => {
    const r = parseRepoUrl("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });

  it("rejects unsupported schemes", () => {
    const r = parseRepoUrl("ftp://example.com/x/y");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported_scheme");
  });

  it("rejects URLs with no path", () => {
    const r = parseRepoUrl("https://github.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported_scheme");
  });
});

describe("planImportFromGit", () => {
  it("produces all 8 steps in order on a valid URL", () => {
    const r = planImportFromGit({
      url: "https://github.com/foo/bar.git",
      targetFolderAbs: "/tmp/imports/bar",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps.map((s) => s.kind)).toEqual([
        "validate_url",
        "ensure_target_folder",
        "git_clone",
        "read_gitignore",
        "translate_to_vscodesync_ignore",
        "scan_files",
        "create_workspace",
        "add_files",
      ]);
      expect(r.parsed.repo).toBe("bar");
    }
  });

  it("propagates URL parse error", () => {
    const r = planImportFromGit({
      url: "ftp://nope",
      targetFolderAbs: "/tmp",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported_scheme");
  });

  it("includes git_clone payload with url and targetFolderAbs", () => {
    const r = planImportFromGit({
      url: "https://github.com/x/y",
      targetFolderAbs: "/tmp/y",
    });
    if (!r.ok) throw new Error("plan failed");
    const cloneStep = r.steps.find((s) => s.kind === "git_clone");
    expect(cloneStep?.payload?.url).toBe("https://github.com/x/y");
    expect(cloneStep?.payload?.targetFolderAbs).toBe("/tmp/y");
  });
});
