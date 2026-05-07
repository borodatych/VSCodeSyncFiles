/**
 * Auth-state tests for OneDriveProvider — complements the deeper
 * `onedriveTokenRefresh.test.ts` which covers the refresh state machine.
 *
 * Goal: cover what's universal across providers via a real `OneDriveProvider`
 * instance — `isAuthenticated`, `logout`, and the UNAUTHORIZED surfacing when
 * no token is in SecretStorage.
 */
import { describe, it, expect } from "vitest";
import { OneDriveProvider, storeOneDriveTokens } from "../../src/providers/onedrive/onedriveProvider.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";
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

describe("OneDriveProvider — auth state", () => {
  it("isAuthenticated false when no token", async () => {
    const p = new OneDriveProvider(memSecrets());
    expect(await p.isAuthenticated()).toBe(false);
  });

  it("isAuthenticated true once a token is stored", async () => {
    const secrets = memSecrets();
    await storeOneDriveTokens(secrets, {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAtMs: Date.now() + 3600_000,
      clientId: "azure-client",
    });
    const p = new OneDriveProvider(secrets);
    expect(await p.isAuthenticated()).toBe(true);
  });

  it("logout clears the bundle", async () => {
    const secrets = memSecrets();
    await storeOneDriveTokens(secrets, {
      accessToken: "tok",
      expiresAtMs: Date.now() + 3600_000,
    });
    const p = new OneDriveProvider(secrets);
    await p.logout();
    expect(await p.isAuthenticated()).toBe(false);
  });

  it("authenticate() guidance points at the device-code command (no programmatic flow)", async () => {
    const p = new OneDriveProvider(memSecrets());
    await expect(p.authenticate()).rejects.toThrow(/Sign in to OneDrive/);
  });

  it("listFolder without a token surfaces ProviderError(UNAUTHORIZED)", async () => {
    const p = new OneDriveProvider(memSecrets());
    await expect(p.listFolder("VSCodeSyncFiles/test")).rejects.toBeInstanceOf(ProviderError);
  });
});
