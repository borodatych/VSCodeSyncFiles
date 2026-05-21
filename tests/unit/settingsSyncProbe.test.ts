/**
 * v2.20.1 — defensive Settings Sync probe tests.
 */
import { describe, expect, it, vi } from "vitest";
import { probeSettingsSyncSession, type AuthSurface } from "../../src/ui/settingsSyncProbe.js";

function authSurface(impl: AuthSurface["getSession"]): AuthSurface {
  return { getSession: impl };
}

describe("probeSettingsSyncSession", () => {
  it("returns provider_missing when getSession returns undefined silently", async () => {
    const auth = authSurface(() => Promise.resolve(undefined));
    const r = await probeSettingsSyncSession(auth, { createIfNone: false });
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toBe("provider_missing");
  });

  it("returns user_rejected when getSession returns undefined and createIfNone=true", async () => {
    const auth = authSurface(() => Promise.resolve(undefined));
    const r = await probeSettingsSyncSession(auth, { createIfNone: true });
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toBe("user_rejected");
  });

  it("returns provider_missing on 'no authentication provider' throw", async () => {
    const auth = authSurface(() => Promise.reject(new Error("No authentication provider 'vscode-settings-sync'")));
    const r = await probeSettingsSyncSession(auth);
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toBe("provider_missing");
  });

  it("returns user_rejected on 'user cancelled' throw", async () => {
    const auth = authSurface(() => Promise.reject(new Error("User cancelled the sign-in flow")));
    const r = await probeSettingsSyncSession(auth);
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toBe("user_rejected");
  });

  it("returns unknown_error on unexpected throw", async () => {
    const auth = authSurface(() => Promise.reject(new Error("network down")));
    const r = await probeSettingsSyncSession(auth);
    expect(r.available).toBe(false);
    if (!r.available) {
      expect(r.reason).toBe("unknown_error");
      expect(r.detail).toContain("network down");
    }
  });

  it("returns available with id+label on session success", async () => {
    const auth = authSurface(() => Promise.resolve({
      id: "sess-1",
      accessToken: "token",
      account: { id: "acc-1", label: "user@example.com" },
      scopes: [],
    }));
    const r = await probeSettingsSyncSession(auth);
    expect(r.available).toBe(true);
    if (r.available) {
      expect(r.sessionId).toBe("sess-1");
      expect(r.accountLabel).toBe("user@example.com");
    }
  });

  it("uses silent=true when createIfNone is not set", async () => {
    const get = vi.fn(() => Promise.resolve(undefined));
    await probeSettingsSyncSession({ getSession: get });
    expect(get).toHaveBeenCalled();
    const lastCall = get.mock.calls[get.mock.calls.length - 1];
    const opts = (lastCall as unknown as unknown[])[2] as { silent?: boolean; createIfNone?: boolean };
    expect(opts.silent).toBe(true);
    expect(opts.createIfNone).toBe(false);
  });
});
