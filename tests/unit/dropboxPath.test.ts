import { describe, expect, it } from "vitest";
import { toDropboxPath } from "../../src/providers/dropbox/dropboxProvider.js";

describe("DropboxProvider.toDropboxPath", () => {
  it("adds leading slash to a clean path", () => {
    expect(toDropboxPath("VSCodeSyncFiles/w81/a.txt")).toBe("/VSCodeSyncFiles/w81/a.txt");
  });

  it("collapses duplicate leading slashes", () => {
    expect(toDropboxPath("//VSCodeSyncFiles/x")).toBe("/VSCodeSyncFiles/x");
    expect(toDropboxPath("////root/file.txt")).toBe("/root/file.txt");
  });

  it("preserves spaces and unicode in the path", () => {
    expect(toDropboxPath("ws/path with spaces/файл.txt")).toBe("/ws/path with spaces/файл.txt");
  });

  it("preserves embedded slashes in directory components", () => {
    expect(toDropboxPath("ws/sub/deep/file.json")).toBe("/ws/sub/deep/file.json");
  });

  it("does not collapse internal double slashes (caller must canonicalize first)", () => {
    // toDropboxPath is intentionally minimal — only the leading-slash form is normalised.
    expect(toDropboxPath("ws//double")).toBe("/ws//double");
  });

  it("handles empty input as the dropbox root", () => {
    expect(toDropboxPath("")).toBe("/");
  });

  it("handles a single leading slash without doubling", () => {
    expect(toDropboxPath("/already/leading")).toBe("/already/leading");
  });
});
