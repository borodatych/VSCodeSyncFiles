import { describe, expect, it, vi, beforeEach } from "vitest";
import { maybeRefreshToken, type OneDriveTokenBundle } from "../../src/providers/onedrive/onedriveProvider.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";

/** Minimal SecretStore mock */
function makeSecrets(initial?: string) {
  let stored: string | undefined = initial;
  return {
    get: vi.fn(() => Promise.resolve(stored)),
    store: vi.fn((_, v: string) => { stored = v; return Promise.resolve(); }),
    delete: vi.fn(() => { stored = undefined; return Promise.resolve(); }),
    getStored: () => stored,
  };
}

describe("OneDrive token refresh (maybeRefreshToken)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns unchanged token when still valid (> 5 min)", async () => {
    const secrets = makeSecrets();
    const bundle: OneDriveTokenBundle = {
      accessToken: "valid-token",
      refreshToken: "refresh",
      expiresAtMs: Date.now() + 30 * 60 * 1000,
      clientId: "client1",
    };
    const result = await maybeRefreshToken(secrets, bundle);
    expect(result.accessToken).toBe("valid-token");
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it("skips refresh when no clientId", async () => {
    const secrets = makeSecrets();
    const bundle: OneDriveTokenBundle = {
      accessToken: "expiring-token",
      refreshToken: "refresh",
      expiresAtMs: Date.now() + 1 * 60 * 1000,
    };
    const result = await maybeRefreshToken(secrets, bundle);
    expect(result.accessToken).toBe("expiring-token");
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it("skips refresh when no refreshToken", async () => {
    const secrets = makeSecrets();
    const bundle: OneDriveTokenBundle = {
      accessToken: "expiring-token",
      expiresAtMs: Date.now() + 1 * 60 * 1000,
      clientId: "client1",
    };
    const result = await maybeRefreshToken(secrets, bundle);
    expect(result.accessToken).toBe("expiring-token");
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it("refreshes and stores new token when near expiry", async () => {
    const secrets = makeSecrets();
    const bundle: OneDriveTokenBundle = {
      accessToken: "old-token",
      refreshToken: "good-refresh",
      expiresAtMs: Date.now() + 1 * 60 * 1000,
      clientId: "client1",
    };
    // A real Response, not a duck-typed literal: `fetchWithTimeout` reads the
    // body through the response object, so the mock must behave like one.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ));
    const result = await maybeRefreshToken(secrets, bundle);
    expect(result.accessToken).toBe("new-token");
    expect(result.refreshToken).toBe("new-refresh");
    expect(secrets.store).toHaveBeenCalled();
    const stored = JSON.parse(secrets.getStored()!) as OneDriveTokenBundle;
    expect(stored.accessToken).toBe("new-token");
  });

  it("throws UNAUTHORIZED on invalid_grant", async () => {
    const secrets = makeSecrets();
    const bundle: OneDriveTokenBundle = {
      accessToken: "old-token",
      refreshToken: "expired-refresh",
      expiresAtMs: Date.now() - 1000,
      clientId: "client1",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    await expect(maybeRefreshToken(secrets, bundle)).rejects.toBeInstanceOf(ProviderError);
  });

  it("falls back to existing token on network error", async () => {
    const secrets = makeSecrets();
    const bundle: OneDriveTokenBundle = {
      accessToken: "old-token",
      refreshToken: "refresh",
      expiresAtMs: Date.now() + 1 * 60 * 1000,
      clientId: "client1",
    };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await maybeRefreshToken(secrets, bundle);
    expect(result.accessToken).toBe("old-token");
  });
});
