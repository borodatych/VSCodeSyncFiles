/**
 * Mock-fetch tests for the Dropbox provider's token-refresh path.
 *
 * What we cover:
 *   - `isAuthenticated` reflects what's in SecretStorage
 *   - Near-expiry token triggers a refresh on the next API call
 *   - Refresh response stores the new access token + expiry in SecretStorage
 *   - 401 from the OAuth endpoint surfaces as `ProviderError("UNAUTHORIZED")`
 *
 * We don't cover any path that needs a real upload/download — those rely on
 * the API/CONTENT split and full RPC envelopes; out of scope for this slice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DropboxProvider } from "../../src/providers/dropbox/dropboxProvider.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";
import {
  readDropboxTokens,
  storeDropboxTokens,
} from "../../src/providers/dropbox/dropboxTokens.js";
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

describe("DropboxProvider — auth state", () => {
  it("isAuthenticated false when no token in SecretStorage", async () => {
    const secrets = memSecrets();
    const p = new DropboxProvider(secrets, () => "appkey");
    expect(await p.isAuthenticated()).toBe(false);
  });

  it("isAuthenticated true once a token is stored", async () => {
    const secrets = memSecrets();
    await storeDropboxTokens(secrets, {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAtMs: Date.now() + 3600_000,
    });
    const p = new DropboxProvider(secrets, () => "appkey");
    expect(await p.isAuthenticated()).toBe(true);
  });

  it("logout clears the stored bundle", async () => {
    const secrets = memSecrets();
    await storeDropboxTokens(secrets, {
      accessToken: "tok",
      expiresAtMs: Date.now() + 3600_000,
    });
    const p = new DropboxProvider(secrets, () => "appkey");
    await p.logout();
    expect(await p.isAuthenticated()).toBe(false);
  });
});

describe("DropboxProvider — token refresh against mocked OAuth endpoint", () => {
  let secrets: SecretStore;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    secrets = memSecrets();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("refresh call posts to /oauth2/token and stores the new access token", async () => {
    const NOW = Date.now();
    // Bundle is near-expiry (under the 5-min skew) → next API call would refresh.
    await storeDropboxTokens(secrets, {
      accessToken: "stale",
      refreshToken: "refresh-XYZ",
      expiresAtMs: NOW + 60_000, // 1 min — well within skew
    });

    let captured: { url: string; body: string } | undefined;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? init.body : "";
      captured = { url, body };
      return Promise.resolve(
        jsonResponse({
          access_token: "fresh-AAA",
          refresh_token: "refresh-ZZZ",
          expires_in: 14_400,
        }),
      );
    });

    const p = new DropboxProvider(secrets, () => "appkey");
    // Use the private path indirectly via the provider's own helper:
    // any call that needs accessToken triggers refresh. listFolder is the
    // simplest — and we'll mock the second fetch call too (to /list_folder).
    let callIdx = 0;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      callIdx++;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (callIdx === 1) {
        // OAuth refresh
        const body = typeof init?.body === "string" ? init.body : "";
        captured = { url, body };
        return Promise.resolve(
          jsonResponse({
            access_token: "fresh-AAA",
            refresh_token: "refresh-ZZZ",
            expires_in: 14_400,
          }),
        );
      }
      // 2nd: list_folder — return empty list to satisfy listFolder
      return Promise.resolve(jsonResponse({ entries: [], has_more: false }));
    });

    await p.listFolder("VSCodeSyncFiles/test");

    // Verify OAuth POST hit /oauth2/token with the right grant_type.
    expect(captured?.url).toMatch(/\/oauth2\/token$/);
    expect(captured?.body).toMatch(/grant_type=refresh_token/);
    expect(captured?.body).toMatch(/refresh_token=refresh-XYZ/);
    expect(captured?.body).toMatch(/client_id=appkey/);

    // Verify SecretStorage updated to new bundle.
    const updated = (await readDropboxTokens(secrets))!;
    expect(updated.accessToken).toBe("fresh-AAA");
    expect(updated.refreshToken).toBe("refresh-ZZZ");
    expect(updated.expiresAtMs).toBeGreaterThan(NOW + 13_000_000);
  });

  it("refresh failure surfaces as ProviderError(UNAUTHORIZED)", async () => {
    await storeDropboxTokens(secrets, {
      accessToken: "stale",
      refreshToken: "refresh-XYZ",
      expiresAtMs: Date.now() + 60_000,
    });
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response("invalid_grant", { status: 401, headers: { "Content-Type": "text/plain" } }),
      ),
    );
    const p = new DropboxProvider(secrets, () => "appkey");
    await expect(p.listFolder("VSCodeSyncFiles/test")).rejects.toBeInstanceOf(ProviderError);
  });

  it("refresh without configured app key surfaces as ProviderError(UNAUTHORIZED)", async () => {
    await storeDropboxTokens(secrets, {
      accessToken: "stale",
      refreshToken: "refresh-XYZ",
      expiresAtMs: Date.now() + 60_000,
    });
    const p = new DropboxProvider(secrets, () => "");
    await expect(p.listFolder("VSCodeSyncFiles/test")).rejects.toThrow(/dropboxAppKey/i);
  });
});

