import { describe, it, expect } from "vitest";
import { parseCliArgs, CliNotImplementedError } from "../../src/core/cliArgsParser.js";

describe("parseCliArgs", () => {
  it("returns help when argv is empty", () => {
    expect(parseCliArgs([])).toEqual({ command: { kind: "help" }, helpRequested: false });
  });

  it("recognises bare status / push / pull", () => {
    expect(parseCliArgs(["status"]).command).toEqual({ kind: "status" });
    expect(parseCliArgs(["push"]).command).toEqual({ kind: "push" });
    expect(parseCliArgs(["pull"]).command).toEqual({ kind: "pull" });
  });

  it("captures positional workspaceId on push / pull", () => {
    expect(parseCliArgs(["push", "WS-1"]).command).toEqual({ kind: "push", workspaceId: "WS-1" });
    expect(parseCliArgs(["pull", "WS-1"]).command).toEqual({ kind: "pull", workspaceId: "WS-1" });
  });

  it("ignores flags when picking positional", () => {
    const r = parseCliArgs(["push", "--verbose", "WS-2"]);
    expect(r.command).toEqual({ kind: "push", workspaceId: "WS-2" });
  });

  it("recognises --help and -h", () => {
    expect(parseCliArgs(["--help"]).helpRequested).toBe(true);
    expect(parseCliArgs(["-h"]).helpRequested).toBe(true);
    expect(parseCliArgs(["status", "--help"]).helpRequested).toBe(true);
  });

  it("sign-in respects --device-code", () => {
    expect(parseCliArgs(["sign-in"]).command).toEqual({ kind: "sign-in", useDeviceCode: false });
    expect(parseCliArgs(["sign-in", "--device-code"]).command).toEqual({ kind: "sign-in", useDeviceCode: true });
  });

  it("unknown command falls through to help with failedCommand", () => {
    expect(parseCliArgs(["whatever"]).command).toEqual({ kind: "help", failedCommand: "whatever" });
  });

  it("explicit help carries optional failedCommand for topic lookup", () => {
    expect(parseCliArgs(["help", "push"]).command).toEqual({ kind: "help", failedCommand: "push" });
  });
});

describe("CliNotImplementedError", () => {
  it("carries the canonical code field", () => {
    const e = new CliNotImplementedError("status");
    expect(e.code).toBe("cli_not_implemented");
    expect(e.message).toContain("status");
  });
});
