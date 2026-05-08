import { describe, expect, it } from "vitest";
import { buildGitFetchCommand } from "../../src/core/gitFetchCommand.js";

describe("buildGitFetchCommand — happy paths", () => {
  it("emits a default `fetch -- origin` argv when no options set", () => {
    const r = buildGitFetchCommand({ repoDirAbs: "/repo" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.argv).toEqual(["fetch", "--", "origin"]);
      expect(r.cwd).toBe("/repo");
      expect(r.env.GIT_TERMINAL_PROMPT).toBe("0");
    }
  });

  it("appends a custom remote", () => {
    const r = buildGitFetchCommand({ repoDirAbs: "/repo", remote: "upstream" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.argv).toEqual(["fetch", "--", "upstream"]);
  });

  it("appends a branch refspec after the remote", () => {
    const r = buildGitFetchCommand({
      repoDirAbs: "/repo",
      branch: "main",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.argv).toEqual(["fetch", "--", "origin", "main"]);
  });

  it("includes --prune / --tags flags before the separator", () => {
    const r = buildGitFetchCommand({
      repoDirAbs: "/repo",
      prune: true,
      tags: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const sep = r.argv.indexOf("--");
      expect(r.argv.slice(0, sep)).toEqual(["fetch", "--prune", "--tags"]);
    }
  });

  it("includes --depth N before the separator", () => {
    const r = buildGitFetchCommand({
      repoDirAbs: "/repo",
      depth: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const sep = r.argv.indexOf("--");
      expect(r.argv.slice(0, sep)).toEqual(["fetch", "--depth", "1"]);
    }
  });
});

describe("buildGitFetchCommand — validation", () => {
  it("rejects empty repo dir", () => {
    expect(buildGitFetchCommand({ repoDirAbs: "" })).toEqual({
      ok: false,
      reason: "empty_repo_dir",
    });
  });

  it("rejects remotes that look like flags", () => {
    expect(
      buildGitFetchCommand({ repoDirAbs: "/repo", remote: "--upload-pack=evil" }),
    ).toEqual({ ok: false, reason: "unsafe_remote" });
  });

  it("rejects branches that look like flags", () => {
    expect(
      buildGitFetchCommand({ repoDirAbs: "/repo", branch: "-evil" }),
    ).toEqual({ ok: false, reason: "unsafe_branch" });
  });

  it("rejects non-positive depth", () => {
    expect(
      buildGitFetchCommand({ repoDirAbs: "/repo", depth: 0 }),
    ).toEqual({ ok: false, reason: "depth_invalid" });
  });

  it("rejects non-integer depth", () => {
    expect(
      buildGitFetchCommand({ repoDirAbs: "/repo", depth: 1.5 }),
    ).toEqual({ ok: false, reason: "depth_invalid" });
  });
});
