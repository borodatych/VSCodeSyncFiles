import { describe, expect, it } from "vitest";
import {
  buildVscodeSyncUri,
  parseVscodeSyncUri,
} from "../../src/core/vscodesyncUriParser.js";

describe("parseVscodeSyncUri", () => {
  it("workspace-only URI", () => {
    const r = parseVscodeSyncUri("vscodesync://workspace/abcd1234");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action).toEqual({ kind: "openWorkspace", workspaceId: "abcd1234" });
    }
  });

  it("workspace + file URI", () => {
    const r = parseVscodeSyncUri("vscodesync://workspace/abcd1234/src/foo.ts");
    expect(r.ok).toBe(true);
    if (r.ok && r.action.kind === "openFile") {
      expect(r.action.workspaceId).toBe("abcd1234");
      expect(r.action.posixRel).toBe("src/foo.ts");
    }
  });

  it("workspace + nested file with encoded spaces", () => {
    const r = parseVscodeSyncUri("vscodesync://workspace/abcd1234/src/my%20file.ts");
    expect(r.ok).toBe(true);
    if (r.ok && r.action.kind === "openFile") {
      expect(r.action.posixRel).toBe("src/my file.ts");
    }
  });

  it("rejects non-vscodesync schemes", () => {
    expect(parseVscodeSyncUri("https://workspace/x").ok).toBe(false);
  });

  it("rejects unknown host", () => {
    expect(parseVscodeSyncUri("vscodesync://something/x").ok).toBe(false);
  });

  it("rejects invalid wid characters", () => {
    expect(parseVscodeSyncUri("vscodesync://workspace/bad id!").ok).toBe(false);
    expect(parseVscodeSyncUri("vscodesync://workspace/ab").ok).toBe(false); // too short
  });

  it("command URI: whitelisted command parses", () => {
    const r = parseVscodeSyncUri("vscodesync://command/vscodesync.openActivityFeed");
    expect(r.ok).toBe(true);
    if (r.ok && r.action.kind === "runCommand") {
      expect(r.action.commandId).toBe("vscodesync.openActivityFeed");
    }
  });

  it("command URI: non-whitelisted command rejected", () => {
    const r = parseVscodeSyncUri("vscodesync://command/vscodesync.deleteWorkspace");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("command_not_whitelisted");
  });

  it("command URI: non-vscodesync namespace rejected", () => {
    const r = parseVscodeSyncUri("vscodesync://command/system.shutdown");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_command_id");
  });

  it("empty / malformed input", () => {
    expect(parseVscodeSyncUri("").ok).toBe(false);
    expect(parseVscodeSyncUri("garbage").ok).toBe(false);
  });
});

describe("buildVscodeSyncUri", () => {
  it("openWorkspace round-trips", () => {
    const uri = buildVscodeSyncUri({ kind: "openWorkspace", workspaceId: "abcd1234" });
    const r = parseVscodeSyncUri(uri);
    expect(r.ok).toBe(true);
  });

  it("openFile encodes path segments", () => {
    const uri = buildVscodeSyncUri({
      kind: "openFile",
      workspaceId: "abcd",
      posixRel: "src/my file.ts",
    });
    expect(uri).toBe("vscodesync://workspace/abcd/src/my%20file.ts");
    const r = parseVscodeSyncUri(uri);
    expect(r.ok).toBe(true);
    if (r.ok && r.action.kind === "openFile") {
      expect(r.action.posixRel).toBe("src/my file.ts");
    }
  });

  it("runCommand round-trips", () => {
    const uri = buildVscodeSyncUri({ kind: "runCommand", commandId: "vscodesync.openActivityFeed" });
    const r = parseVscodeSyncUri(uri);
    expect(r.ok).toBe(true);
  });
});
