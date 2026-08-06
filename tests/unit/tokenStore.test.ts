import { describe, expect, it, vi } from "vitest";
import {
  createTokenStore,
  secretKeyForAccountSlot,
  secretKeyForProvider,
  type OAuthTokenBundle,
} from "../../src/providers/_shared/tokenStore.js";

function makeSecrets(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set("vscodesync.gdrive.oauth", initial);
  return {
    store: map,
    get: vi.fn((k: string) => Promise.resolve(map.get(k))),
    delete: vi.fn((k: string) => {
      map.delete(k);
      return Promise.resolve();
    }),
  };
}

function secretStore(m: ReturnType<typeof makeSecrets>) {
  return {
    get: m.get,
    store: (k: string, v: string) => {
      m.store.set(k, v);
      return Promise.resolve();
    },
    delete: m.delete,
  };
}

describe("secretKeyForProvider", () => {
  it("совпадает с фактическим форматом ключей расширения", () => {
    expect(secretKeyForProvider("onedrive")).toBe("vscodesync.onedrive.oauth");
    expect(secretKeyForProvider("gdrive")).toBe("vscodesync.gdrive.oauth");
    expect(secretKeyForProvider("yandex")).toBe("vscodesync.yandex.oauth");
    expect(secretKeyForProvider("dropbox")).toBe("vscodesync.dropbox.oauth");
  });

  it("слот мультиаккаунта висит на том же ключе", () => {
    expect(secretKeyForAccountSlot("dropbox", "work")).toBe("vscodesync.dropbox.oauth:work");
  });
});

describe("createTokenStore", () => {
  it("read возвращает null на пустом и на битом JSON", async () => {
    const m = makeSecrets();
    const store = createTokenStore<OAuthTokenBundle>(secretStore(m), "gdrive");
    await expect(store.read()).resolves.toBeNull();
    m.store.set("vscodesync.gdrive.oauth", "{not json");
    await expect(store.read()).resolves.toBeNull();
  });

  it("write → read делает круг", async () => {
    const m = makeSecrets();
    const store = createTokenStore<OAuthTokenBundle>(secretStore(m), "gdrive");
    await store.write({ accessToken: "a", refreshToken: "r", expiresAtMs: 42 });
    await expect(store.read()).resolves.toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAtMs: 42,
    });
  });

  it("refreshOnce: параллельные вызовы делят один запрос", async () => {
    const m = makeSecrets();
    const store = createTokenStore<OAuthTokenBundle>(secretStore(m), "gdrive");
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const refresh = async (): Promise<OAuthTokenBundle> => {
      calls += 1;
      await gate;
      return { accessToken: `token-${String(calls)}`, expiresAtMs: 1 };
    };

    const all = Promise.all([
      store.refreshOnce(refresh),
      store.refreshOnce(refresh),
      store.refreshOnce(refresh),
    ]);
    release?.();
    const results = await all;

    expect(calls).toBe(1);
    expect(results.map((r) => r.accessToken)).toEqual(["token-1", "token-1", "token-1"]);
  });

  it("refreshOnce: провалившийся refresh не блокирует следующий", async () => {
    const m = makeSecrets();
    const store = createTokenStore<OAuthTokenBundle>(secretStore(m), "gdrive");
    await expect(
      store.refreshOnce(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    await expect(
      store.refreshOnce(() => Promise.resolve({ accessToken: "ok", expiresAtMs: 1 })),
    ).resolves.toEqual({ accessToken: "ok", expiresAtMs: 1 });
  });
});
