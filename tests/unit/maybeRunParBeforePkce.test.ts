/**
 * v2.20.4 — PAR auto-activate hook tests.
 */
import { describe, expect, it } from "vitest";
import { maybeRunParBeforePkce } from "../../src/auth/maybeRunParBeforePkce.js";

const PARAMS = {
  clientId: "c",
  redirectUri: "vscode://r",
  responseType: "code" as const,
  scope: "s",
  state: "st",
  codeChallenge: "ch",
  codeChallengeMethod: "S256" as const,
};

describe("maybeRunParBeforePkce", () => {
  it("returns fallback_to_pkce for every provider today (parEndpointUrl: null)", async () => {
    for (const providerId of ["onedrive", "gdrive", "dropbox", "yandex"] as const) {
      const r = await maybeRunParBeforePkce({
        providerId,
        authorizeEndpoint: "https://auth.example.com/authorize",
        params: PARAMS,
      });
      expect(r.kind).toBe("fallback_to_pkce");
    }
  });

  it("forwards to PKCE without making a network request", async () => {
    let called = false;
    await maybeRunParBeforePkce({
      providerId: "onedrive",
      authorizeEndpoint: "https://auth.example.com/authorize",
      params: PARAMS,
      fetchImpl: () => {
        called = true;
        return Promise.resolve(new Response("{}"));
      },
    });
    expect(called).toBe(false);
  });
});
