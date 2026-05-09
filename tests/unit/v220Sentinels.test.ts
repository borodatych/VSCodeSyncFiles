/**
 * Smoke coverage for the v2.20.* skeleton sentinel error classes added in
 * the latest roadmap-max pass. Each sentinel must:
 *   - Carry a stable string `code` field (so UI can branch by code, not
 *     by `instanceof` across module boundaries).
 *   - Carry a non-empty `message` mentioning "skeleton" so the user sees
 *     a clear hint when the error reaches a UI layer.
 */
import { describe, it, expect } from "vitest";
import { AnalyticsBackendNotImplementedError } from "../../src/core/analyticsQueryShape.js";
import { CliNotImplementedError } from "../../src/core/cliArgsParser.js";
import { McpNotImplementedError } from "../../src/core/mcpServerContract.js";
import { TemplateMarketplaceNotImplementedError } from "../../src/core/workspaceTemplate.js";
import {
  WebAuthnNotImplementedError,
  makeSkeletonWebAuthnAdapter,
} from "../../src/core/webauthnPlatformAdapter.js";

describe("v2.20 skeleton sentinels", () => {
  const cases: { err: Error & { code: string }; expected: string }[] = [
    { err: new AnalyticsBackendNotImplementedError(), expected: "analytics_backend_not_implemented" },
    { err: new CliNotImplementedError("status"), expected: "cli_not_implemented" },
    { err: new McpNotImplementedError(), expected: "mcp_not_implemented" },
    { err: new TemplateMarketplaceNotImplementedError(), expected: "template_marketplace_not_implemented" },
    { err: new WebAuthnNotImplementedError("browser"), expected: "webauthn_not_implemented" },
  ];

  for (const c of cases) {
    it(`${c.err.name} has code "${c.expected}" and a "skeleton" hint`, () => {
      expect(c.err.code).toBe(c.expected);
      expect(c.err.message.toLowerCase()).toContain("skeleton");
    });
  }
});

describe("makeSkeletonWebAuthnAdapter", () => {
  it("reports available=false and throws on enroll/unlock", async () => {
    const adapter = makeSkeletonWebAuthnAdapter("browser");
    expect(adapter.available).toBe(false);
    expect(adapter.platform).toBe("browser");
    await expect(
      adapter.enroll({
        rpId: "vscodesync",
        rpName: "VSCodeSync",
        userHandle: new Uint8Array(8),
        userDisplayName: "user",
      }),
    ).rejects.toBeInstanceOf(WebAuthnNotImplementedError);
    await expect(
      adapter.unlock({ rpId: "vscodesync", allowedCredentialIds: [] }),
    ).rejects.toBeInstanceOf(WebAuthnNotImplementedError);
  });
});
