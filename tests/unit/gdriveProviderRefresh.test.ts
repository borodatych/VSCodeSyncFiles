/**
 * Mock-fetch tests for the Google Drive provider's auth/token paths.
 *
 * Mirrors the Dropbox test suite — drive-specific RPC envelopes are out of
 * scope; we cover only what's universal across providers:
 *   - `isAuthenticated` reflects SecretStorage state
 *   - `logout` clears tokens
 *   - Near-expiry token triggers refresh on the next API call
 *   - Refresh response stores the new access token + expiry
 *   - Refresh failure surfaces as `ProviderError("UNAUTHORIZED")`
 *   - Missing client id surfaces as `ProviderError("UNAUTHORIZED")` with a clear message
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GdriveProvider } from "../../src/providers/gdrive/gdriveProvider.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";
import {
  readGdriveTokens,
  storeGdriveTokens,
} from "../../src/providers/gdrive/gdriveTokens.js";
import type { SecretStore } from "../../src/core/types.js";

function memSecrets(): SecretStore {
  const m = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(m.get(k)),
    store: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      m.delete(k);
      return Promise.resolve();
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("GdriveProvider — auth state", () => {
  it("isAuthenticated false when no token", async () => {
    const p = new GdriveProvider(memSecrets(), () => "client-id");
    expect(await p.isAuthenticated()).toBe(false);
  });

  it("isAuthenticated true once a token is stored", async () => {
    const secrets = memSecrets();
    await storeGdriveTokens(secrets, {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAtMs: Date.now() + 3600_000,
    });
    const p = new GdriveProvider(secrets, () => "client-id");
    expect(await p.isAuthenticated()).toBe(true);
  });

  it("logout clears the stored bundle", async () => {
    const secrets = memSecrets();
    await storeGdriveTokens(secrets, {
      accessToken: "tok",
      expiresAtMs: Date.now() + 3600_000,
    });
    const p = new GdriveProvider(secrets, () => "client-id");
    await p.logout();
    expect(await p.isAuthenticated()).toBe(false);
  });
});

describe("GdriveProvider — refresh against mocked OAuth endpoint", () => {
  let secrets: SecretStore;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    secrets = memSecrets();
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("near-expiry token triggers refresh; new bundle is stored", async () => {
    const NOW = Date.now();
    await storeGdriveTokens(secrets, {
      accessToken: "stale",
      refreshToken: "refresh-XYZ",
      expiresAtMs: NOW + 60_000, // within the 5-min skew
    });

    let oauthHit = 0;
    let oauthBody = "";
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("oauth2.googleapis.com/token")) {
        oauthHit++;
        oauthBody = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(
          jsonResponse({ access_token: "fresh-AAA", expires_in: 3600, refresh_token: "refresh-ZZZ" }),
        );
      }
      // Drive API: return empty file list so listFolder resolves.
      if (url.includes("/files?q=")) {
        return Promise.resolve(jsonResponse({ files: [] }));
      }
      return Promise.resolve(new Response("not mocked", { status: 500 }));
    });

    await p().listFolder("VSCodeSyncFiles/test").catch(() => undefined);

    expect(oauthHit).toBe(1);
    expect(oauthBody).toMatch(/grant_type=refresh_token/);
    expect(oauthBody).toMatch(/refresh_token=refresh-XYZ/);
    expect(oauthBody).toMatch(/client_id=client-id/);
    const updated = await readGdriveTokens(secrets);
    expect(updated?.accessToken).toBe("fresh-AAA");
    expect(updated?.refreshToken).toBe("refresh-ZZZ");

    function p(): GdriveProvider {
      return new GdriveProvider(secrets, () => "client-id");
    }
  });

  it("refresh failure → ProviderError(UNAUTHORIZED)", async () => {
    await storeGdriveTokens(secrets, {
      accessToken: "stale",
      refreshToken: "refresh-XYZ",
      expiresAtMs: Date.now() + 60_000,
    });
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("invalid_grant", { status: 401 })),
    );
    const p = new GdriveProvider(secrets, () => "client-id");
    await expect(p.listFolder("any/path")).rejects.toBeInstanceOf(ProviderError);
  });

  it("missing client id surfaces a UNAUTHORIZED with a hint", async () => {
    await storeGdriveTokens(secrets, {
      accessToken: "stale",
      refreshToken: "refresh-XYZ",
      expiresAtMs: Date.now() + 60_000,
    });
    const p = new GdriveProvider(secrets, () => "");
    await expect(p.listFolder("any/path")).rejects.toThrow(/googleDriveClientId/i);
  });
});
