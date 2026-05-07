import { describe, expect, it } from "vitest";
import { toDropboxPath } from "../../src/providers/dropbox/dropboxProvider.js";

describe("DropboxProvider path helpers", () => {
  it("toDropboxPath adds leading slash", () => {
    expect(toDropboxPath("VSCodeSyncFiles/w81/a.txt")).toBe("/VSCodeSyncFiles/w81/a.txt");
  });

  it("toDropboxPath strips duplicate slashes", () => {
    expect(toDropboxPath("//VSCodeSyncFiles/x")).toBe("/VSCodeSyncFiles/x");
  });
});
