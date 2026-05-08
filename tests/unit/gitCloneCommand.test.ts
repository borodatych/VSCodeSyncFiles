import { describe, expect, it } from "vitest";
import {
  buildGitCloneCommand,
  sanitiseEnv,
} from "../../src/core/gitCloneCommand.js";

describe("buildGitCloneCommand — happy paths", () => {
  it("emits a minimal clone argv when no options are set", () => {
    const r = buildGitCloneCommand({
      url: "https://github.com/me/dotfiles.git",
      parentDirAbs: "/home/me/projects",
      folderName: "dotfiles",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.argv).toEqual([
        "clone",
        "--",
        "https://github.com/me/dotfiles.git",
        "dotfiles",
      ]);
      expect(r.cwd).toBe("/home/me/projects");
    }
  });

  it("appends --depth N when supplied", () => {
    const r = buildGitCloneCommand({
      url: "https://github.com/me/repo",
      parentDirAbs: "/p",
      folderName: "repo",
      depth: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.argv).toContain("--depth");
    if (r.ok) {
      const i = r.argv.indexOf("--depth");
      expect(r.argv[i + 1]).toBe("1");
    }
  });

  it("appends --branch when supplied", () => {
    const r = buildGitCloneCommand({
      url: "https://github.com/me/repo",
      parentDirAbs: "/p",
      folderName: "repo",
      branch: "main",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const i = r.argv.indexOf("--branch");
      expect(r.argv[i + 1]).toBe("main");
    }
  });

  it("appends --recurse-submodules when requested", () => {
    const r = buildGitCloneCommand({
      url: "https://github.com/me/repo",
      parentDirAbs: "/p",
      folderName: "repo",
      recurseSubmodules: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.argv).toContain("--recurse-submodules");
  });
});

describe("buildGitCloneCommand — validation", () => {
  it("rejects empty URL", () => {
    expect(
      buildGitCloneCommand({ url: "", parentDirAbs: "/p", folderName: "r" }),
    ).toEqual({ ok: false, reason: "empty_url" });
  });

  it("rejects empty folder name", () => {
    expect(
      buildGitCloneCommand({
        url: "https://x/y/z",
        parentDirAbs: "/p",
        folderName: "",
      }),
    ).toEqual({ ok: false, reason: "empty_folder_name" });
  });

  it("rejects folder names containing path separators (../escape)", () => {
    expect(
      buildGitCloneCommand({
        url: "https://x/y/z",
        parentDirAbs: "/p",
        folderName: "../etc",
      }),
    ).toEqual({ ok: false, reason: "unsafe_folder_name" });
  });

  it("rejects folder names that look like flags", () => {
    expect(
      buildGitCloneCommand({
        url: "https://x/y/z",
        parentDirAbs: "/p",
        folderName: "--upload-pack=evil",
      }),
    ).toEqual({ ok: false, reason: "unsafe_folder_name" });
  });

  it("rejects bare '..' folder name", () => {
    expect(
      buildGitCloneCommand({
        url: "https://x/y/z",
        parentDirAbs: "/p",
        folderName: "..",
      }),
    ).toEqual({ ok: false, reason: "unsafe_folder_name" });
  });

  it("rejects non-positive depth", () => {
    expect(
      buildGitCloneCommand({
        url: "https://x/y/z",
        parentDirAbs: "/p",
        folderName: "r",
        depth: 0,
      }),
    ).toEqual({ ok: false, reason: "depth_invalid" });
  });
});

describe("buildGitCloneCommand — argv ordering", () => {
  it("places `--` before the URL so a malicious URL cannot be parsed as flags", () => {
    const r = buildGitCloneCommand({
      url: "--upload-pack=evil",
      parentDirAbs: "/p",
      folderName: "r",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const sepIndex = r.argv.indexOf("--");
      const urlIndex = r.argv.indexOf("--upload-pack=evil");
      expect(sepIndex).toBeGreaterThan(-1);
      expect(urlIndex).toBeGreaterThan(sepIndex);
    }
  });
});

describe("sanitiseEnv", () => {
  it("strips GIT_DIR / GIT_WORK_TREE / GIT_ASKPASS / SSH_ASKPASS from baseline", () => {
    const baseline: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      GIT_DIR: "/evil",
      GIT_WORK_TREE: "/evil",
      GIT_ASKPASS: "/evil",
      SSH_ASKPASS: "/evil",
      HOME: "/home/me",
    };
    const env = sanitiseEnv(baseline);
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/me");
  });

  it("forces GIT_TERMINAL_PROMPT=0 so spawn does not hang on credential prompt", () => {
    const env = sanitiseEnv({ HOME: "/home/me" });
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
