import { describe, expect, it } from "vitest";

import { parseArgv } from "../../cli/src/parseArgs.js";

describe("parseArgv", () => {
  it("parses status with cwd", () => {
    const cwd = process.cwd();
    const r = parseArgv(["status", "--cwd", cwd]);
    expect(r.command).toBe("status");
    expect(r.status?.cwd).toBe(cwd);
  });

  it("parses pull workspace", () => {
    const r = parseArgv(["pull", "--workspace", "abc123"]);
    expect(r.command).toBe("pull");
    expect(r.pull?.workspace).toBe("abc123");
  });

  it("parses pull --token", () => {
    const r = parseArgv(["pull", "--token", "secret-token"]);
    expect(r.pull?.token).toBe("secret-token");
  });

  it("sets help", () => {
    expect(parseArgv(["--help"]).help).toBe(true);
  });

  it("parses auth --device-code", () => {
    const r = parseArgv(["auth", "--device-code"]);
    expect(r.command).toBe("auth");
    expect(r.auth?.deviceCode).toBe(true);
    expect(r.auth?.provider).toBe("onedrive");
  });

  it("parses auth --provider with --client-id", () => {
    const r = parseArgv(["auth", "--device-code", "--provider", "onedrive", "--client-id", "abc-client"]);
    expect(r.auth?.provider).toBe("onedrive");
    expect(r.auth?.clientId).toBe("abc-client");
    expect(r.auth?.deviceCode).toBe(true);
  });

  it("auth without --device-code sets deviceCode false", () => {
    const r = parseArgv(["auth", "--provider", "onedrive"]);
    expect(r.command).toBe("auth");
    expect(r.auth?.deviceCode).toBe(false);
  });

  it("pull-all sets correct command", () => {
    const r = parseArgv(["pull-all"]);
    expect(r.command).toBe("pull-all");
    expect(r.pull?.command).toBe("pull-all");
  });
});
