import { describe, expect, it, vi, afterEach } from "vitest";

import { EXIT_AUTH, EXIT_GENERAL, EXIT_NOT_FOUND, EXIT_OK } from "../../cli/src/exitCodes.js";

/**
 * Tests for CLI exit code logic — validates constants and ensures consistency
 * with the documented spec (docs/v1/08-platform/cli.md).
 */
describe("exit code constants", () => {
  it("EXIT_OK is 0", () => expect(EXIT_OK).toBe(0));
  it("EXIT_GENERAL is 1", () => expect(EXIT_GENERAL).toBe(1));
  it("EXIT_AUTH is 2", () => expect(EXIT_AUTH).toBe(2));
  it("EXIT_NOT_FOUND is 4", () => expect(EXIT_NOT_FOUND).toBe(4));
  it("all exit codes are unique", () => {
    const codes = [EXIT_OK, EXIT_GENERAL, EXIT_AUTH, EXIT_NOT_FOUND];
    expect(new Set(codes).size).toBe(codes.length);
  });
});

/**
 * hasAnyCredentials: env var path.
 */
describe("hasAnyCredentials — env path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true when VSCODESYNC_TOKEN set", async () => {
    vi.stubEnv("VSCODESYNC_TOKEN", "test-access-token");
    const { hasAnyCredentials } = await import("../../cli/src/secretStoreEnv.js");
    expect(await hasAnyCredentials()).toBe(true);
  });

  it("returns true when overrideToken provided", async () => {
    vi.stubEnv("VSCODESYNC_TOKEN", "");
    const { hasAnyCredentials } = await import("../../cli/src/secretStoreEnv.js");
    expect(await hasAnyCredentials("explicit-token")).toBe(true);
  });
});

/**
 * cmdAuth: rejects unknown providers and missing client-id.
 */
describe("runAuth validation", () => {
  it("returns EXIT_GENERAL when --device-code not set", async () => {
    const { runAuth } = await import("../../cli/src/cmdAuth.js");
    const code = await runAuth({ command: "auth", provider: "onedrive", clientId: undefined, deviceCode: false });
    expect(code).toBe(EXIT_GENERAL);
  });

  it("returns EXIT_GENERAL for unsupported provider", async () => {
    const { runAuth } = await import("../../cli/src/cmdAuth.js");
    const code = await runAuth({ command: "auth", provider: "gdrive", clientId: "id", deviceCode: true });
    expect(code).toBe(EXIT_GENERAL);
  });

  it("returns EXIT_GENERAL when clientId missing and env not set", async () => {
    vi.stubEnv("VSCODESYNC_ONEDRIVE_CLIENT_ID", "");
    const { runAuth } = await import("../../cli/src/cmdAuth.js");
    const code = await runAuth({ command: "auth", provider: "onedrive", clientId: undefined, deviceCode: true });
    expect(code).toBe(EXIT_GENERAL);
    vi.unstubAllEnvs();
  });
});
