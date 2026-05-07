/**
 * Mock-fetch tests for the Yandex.Disk provider — auth-state and refresh
 * behaviours. The full RPC surface (download/upload chunked + 423 lock retry)
 * needs deeper provider-specific mocks; out of scope for this slice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { YandexDiskProvider } from "../../src/providers/yandex/yandexDiskProvider.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";
import {
  readYandexTokens,
  storeYandexTokens,
} from "../../src/providers/yandex/yandexTokens.js";
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

describe("YandexDiskProvider — auth state", () => {
  it("isAuthenticated false when no token", async () => {
    const p = new YandexDiskProvider(memSecrets(), () => "client-id");
    expect(await p.isAuthenticated()).toBe(false);
  });

  it("isAuthenticated true once a token is stored", async () => {
    const secrets = memSecrets();
    await storeYandexTokens(secrets, {
      accessToken: "tok",
      expiresAtMs: Date.now() + 3600_000,
    });
    const p = new YandexDiskProvider(secrets, () => "client-id");
    expect(await p.isAuthenticated()).toBe(true);
  });

  it("logout clears the bundle", async () => {
    const secrets = memSecrets();
    await storeYandexTokens(secrets, {
      accessToken: "tok",
      expiresAtMs: Date.now() + 3600_000,
    });
    const p = new YandexDiskProvider(secrets, () => "client-id");
    await p.logout();
    expect(await p.isAuthenticated()).toBe(false);
  });
});

describe("YandexDiskProvider — refresh against mocked OAuth endpoint", () => {
  let secrets: SecretStore;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    secrets = memSecrets();
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("near-expiry token triggers refresh; stored bundle keeps refresh token", async () => {
    await storeYandexTokens(secrets, {
      accessToken: "stale",
      refreshToken: "refresh-XYZ",
      expiresAtMs: Date.now() + 60_000, // within 5-min skew
    });
    let oauthHit = 0;
    let oauthBody = "";
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("oauth.yandex.ru/token")) {
        oauthHit++;
        oauthBody = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(
          jsonResponse({ access_token: "fresh-AAA", refresh_token: "refresh-ZZZ", expires_in: 31536000 }),
        );
      }
      // Yandex Disk REST: empty resource list
      return Promise.resolve(
        jsonResponse({ _embedded: { items: [] } }),
      );
    });
    const p = new YandexDiskProvider(secrets, () => "client-id");
    await p.listFolder("VSCodeSyncFiles/test").catch(() => undefined);
    expect(oauthHit).toBe(1);
    expect(oauthBody).toMatch(/grant_type=refresh_token/);
    expect(oauthBody).toMatch(/refresh_token=refresh-XYZ/);
    expect(oauthBody).toMatch(/client_id=client-id/);
    const updated = await readYandexTokens(secrets);
    expect(updated?.accessToken).toBe("fresh-AAA");
    expect(updated?.refreshToken).toBe("refresh-ZZZ");
  });

  it("refresh failure → ProviderError(UNAUTHORIZED)", async () => {
    await storeYandexTokens(secrets, {
      accessToken: "stale",
      refreshToken: "refresh-XYZ",
      expiresAtMs: Date.now() + 60_000,
    });
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("invalid_grant", { status: 401 })),
    );
    const p = new YandexDiskProvider(secrets, () => "client-id");
    await expect(p.listFolder("any/path")).rejects.toBeInstanceOf(ProviderError);
  });

  it("missing client id → UNAUTHORIZED hint", async () => {
    await storeYandexTokens(secrets, {
      accessToken: "stale",
      refreshToken: "refresh-XYZ",
      expiresAtMs: Date.now() + 60_000,
    });
    const p = new YandexDiskProvider(secrets, () => "");
    await expect(p.listFolder("any/path")).rejects.toThrow(/yandexOAuthClientId/i);
  });

  it("rate-limited (429) propagates as ProviderError(RATE_LIMITED)", async () => {
    await storeYandexTokens(secrets, {
      accessToken: "valid",
      expiresAtMs: Date.now() + 3600_000,
    });
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response("rate limit", {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
      ),
    );
    const p = new YandexDiskProvider(secrets, () => "client-id");
    try {
      await p.listFolder("any/path");
      throw new Error("expected ProviderError");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(ProviderError);
      if (e instanceof ProviderError) {
        expect(e.code).toBe("RATE_LIMITED");
      }
    }
  });
});
