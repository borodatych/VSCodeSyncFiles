import { describe, expect, it } from "vitest";
import { detectWorkspaceContext } from "../../src/core/workspaceContextDetector.js";

describe("detectWorkspaceContext", () => {
  it("plain folder → normal", () => {
    const r = detectWorkspaceContext({
      folderPath: "/repo",
      siblings: ["src", "package.json"],
    });
    expect(r.kind).toBe("normal");
  });

  it("folder with .devcontainer/ → devcontainer kind", () => {
    const r = detectWorkspaceContext({
      folderPath: "/repo",
      siblings: [".git", ".devcontainer", "src"],
    });
    expect(r.kind).toBe("devcontainer");
  });

  it("devcontainer image extracted from snippet", () => {
    const snippet = `{
      "name": "dev",
      "image": "mcr.microsoft.com/devcontainers/typescript-node:18"
    }`;
    const r = detectWorkspaceContext({
      folderPath: "/repo",
      siblings: ["src"],
      devcontainerSnippet: snippet,
    });
    expect(r.kind).toBe("devcontainer");
    expect(r.devcontainerImage).toBe("mcr.microsoft.com/devcontainers/typescript-node:18");
  });

  it("worktree path → worktree kind + parent repo extracted", () => {
    const r = detectWorkspaceContext({
      folderPath: "/repo-feat-x",
      siblings: [".git"],
      resolvedGitDir: "/home/u/myrepo/.git/worktrees/feat-x",
      gitHeadContent: "ref: refs/heads/feat-x\n",
    });
    expect(r.kind).toBe("worktree");
    expect(r.parentRepoPath).toBe("/home/u/myrepo");
    expect(r.worktreeBranch).toBe("feat-x");
  });

  it("worktree without HEAD branch — graceful undefined", () => {
    const r = detectWorkspaceContext({
      folderPath: "/repo",
      siblings: [".git"],
      resolvedGitDir: "/home/u/myrepo/.git/worktrees/wip",
    });
    expect(r.kind).toBe("worktree");
    expect(r.worktreeBranch).toBeUndefined();
  });

  it("submodule path → submodule kind", () => {
    const r = detectWorkspaceContext({
      folderPath: "/repo/vendor/lib",
      siblings: [".git"],
      resolvedGitDir: "/home/u/myrepo/.git/modules/vendor/lib",
    });
    expect(r.kind).toBe("submodule");
    expect(r.parentRepoPath).toBe("/home/u/myrepo");
  });
});
