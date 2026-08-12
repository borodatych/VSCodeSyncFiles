/**
 * Native server-side `moveFile` across the four real providers, the queue
 * wrapper forwarding, and the canonical-relocation fallback when a native
 * move fails. Each provider talks to a URL-routing fake `fetch` — the same
 * pattern as providerParityAndUpload.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropboxProvider } from "../../src/providers/dropbox/dropboxProvider.js";
import { storeDropboxTokens } from "../../src/providers/dropbox/dropboxTokens.js";
import { GdriveProvider } from "../../src/providers/gdrive/gdriveProvider.js";
import { storeGdriveTokens } from "../../src/providers/gdrive/gdriveTokens.js";
import { OneDriveProvider } from "../../src/providers/onedrive/onedriveProvider.js";
import { YandexDiskProvider } from "../../src/providers/yandex/yandexDiskProvider.js";
import { storeYandexTokens } from "../../src/providers/yandex/yandexTokens.js";
import { secretKeyForProvider } from "../../src/providers/_shared/tokenStore.js";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { wrapWithQueue } from "../../src/core/queuedProvider.js";
import { relocateBlobsForMoves } from "../../src/core/io/canonicalRelocation.js";
import { blobCloudPath } from "../../src/core/wireCompression.js";
import type { MetaJson } from "../../src/core/cloudLayout.js";
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

type Route = (url: string, init: RequestInit | undefined) => Response | undefined;

/** Request bodies in these tests are always JSON strings. */
function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}

/** First matching route answers; an unmatched request fails the test loudly. */
function routedFetch(routes: Route[]): typeof globalThis.fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const route of routes) {
      const r = route(url, init);
      if (r) return Promise.resolve(r);
    }
    return Promise.reject(new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`));
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("Dropbox.moveFile", () => {
  async function makeProvider(): Promise<DropboxProvider> {
    const secrets = memSecrets();
    await storeDropboxTokens(secrets, {
      accessToken: "t",
      refreshToken: "r",
      expiresAtMs: Date.now() + 3600_000,
    });
    return new DropboxProvider(secrets, () => "app-key");
  }

  it("move_v2 после ensureParentFolders, etag = rev", async () => {
    const calls: string[] = [];
    globalThis.fetch = routedFetch([
      (url, init) => {
        if (url.endsWith("/2/files/create_folder_v2")) {
          const body = JSON.parse(bodyText(init)) as { path: string };
          calls.push(`mkdir:${body.path}`);
          return json({});
        }
        return undefined;
      },
      (url, init) => {
        if (url.endsWith("/2/files/move_v2")) {
          const body = JSON.parse(bodyText(init)) as { from_path: string; to_path: string };
          calls.push(`move:${body.from_path}->${body.to_path}`);
          return json({ metadata: { ".tag": "file", rev: "rev42" } });
        }
        return undefined;
      },
    ]);
    const p = await makeProvider();
    const res = await p.moveFile("VSCodeSyncFiles/ws1/src/a.ts", "VSCodeSyncFiles/ws1/lib/b.ts");
    expect(res.etag).toBe("rev42");
    expect(calls).toContain("move:/VSCodeSyncFiles/ws1/src/a.ts->/VSCodeSyncFiles/ws1/lib/b.ts");
    expect(calls).toContain("mkdir:/VSCodeSyncFiles/ws1/lib");
  });

  it("409 not_found источника → ProviderError NOT_FOUND", async () => {
    globalThis.fetch = routedFetch([
      (url) => (url.endsWith("/2/files/create_folder_v2") ? json({}) : undefined),
      (url) =>
        url.endsWith("/2/files/move_v2")
          ? new Response(JSON.stringify({ error_summary: "from_lookup/not_found/..." }), { status: 409 })
          : undefined,
    ]);
    const p = await makeProvider();
    await expect(p.moveFile("VSCodeSyncFiles/ws1/gone.ts", "VSCodeSyncFiles/ws1/lib/b.ts")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("YandexDiskProvider.moveFile", () => {
  async function makeProvider(): Promise<YandexDiskProvider> {
    const secrets = memSecrets();
    await storeYandexTokens(secrets, {
      accessToken: "t",
      refreshToken: "r",
      expiresAtMs: Date.now() + 3600_000,
    });
    return new YandexDiskProvider(secrets, () => "client-id");
  }

  it("синхронный move (201): родители создаются, etag читается getMetadata(to)", async () => {
    const calls: string[] = [];
    globalThis.fetch = routedFetch([
      (url, init) => {
        if (url.includes("/resources?path=") && init?.method === "PUT") {
          calls.push("mkdir");
          return json({}, 201);
        }
        return undefined;
      },
      (url, init) => {
        if (url.includes("/resources/move?") && init?.method === "POST") {
          calls.push(`move:${url.split("/resources/move?")[1]}`);
          return json({ href: "" }, 201);
        }
        return undefined;
      },
      (url, init) => {
        if (url.includes("/resources?path=") && (init?.method === undefined || init.method === "GET")) {
          return json({ type: "file", size: 3, etag: "y-etag-7", md5: "aa" });
        }
        return undefined;
      },
    ]);
    const p = await makeProvider();
    const res = await p.moveFile("VSCodeSyncFiles/ws1/src/a.ts", "VSCodeSyncFiles/ws1/lib/b.ts");
    expect(res.etag).toBe("y-etag-7");
    expect(calls.some((c) => c.startsWith("move:") && c.includes("overwrite=true"))).toBe(true);
    expect(calls).toContain("mkdir");
  });

  it("404 источника → ProviderError NOT_FOUND", async () => {
    globalThis.fetch = routedFetch([
      (url, init) => (url.includes("/resources?path=") && init?.method === "PUT" ? json({}, 201) : undefined),
      (url, init) =>
        url.includes("/resources/move?") && init?.method === "POST"
          ? new Response(JSON.stringify({ error: "DiskNotFoundError" }), { status: 404 })
          : undefined,
    ]);
    const p = await makeProvider();
    await expect(p.moveFile("VSCodeSyncFiles/ws1/gone.ts", "VSCodeSyncFiles/ws1/lib/b.ts")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("асинхронный move (202): поллинг операции до success", async () => {
    let polls = 0;
    globalThis.fetch = routedFetch([
      (url, init) => (url.includes("/resources?path=") && init?.method === "PUT" ? json({}, 201) : undefined),
      (url, init) =>
        url.includes("/resources/move?") && init?.method === "POST"
          ? json({ href: "https://cloud-api.yandex.net/v1/disk/operations?id=op1" }, 202)
          : undefined,
      (url) => {
        if (url.includes("/operations?id=op1")) {
          polls += 1;
          return json({ status: polls < 2 ? "in-progress" : "success" });
        }
        return undefined;
      },
      (url, init) =>
        url.includes("/resources?path=") && (init?.method === undefined || init.method === "GET")
          ? json({ type: "file", size: 3, etag: "y-etag-8" })
          : undefined,
    ]);
    const p = await makeProvider();
    const res = await p.moveFile("VSCodeSyncFiles/ws1/src/a.ts", "VSCodeSyncFiles/ws1/lib/b.ts");
    expect(res.etag).toBe("y-etag-8");
    expect(polls).toBe(2);
  }, 15_000);
});

describe("GdriveProvider.moveFile", () => {
  async function makeProvider(): Promise<GdriveProvider> {
    const secrets = memSecrets();
    await storeGdriveTokens(secrets, {
      accessToken: "t",
      refreshToken: "r",
      expiresAtMs: Date.now() + 3600_000,
    });
    return new GdriveProvider(secrets, () => "client-id");
  }

  const CHILD_BY_NAME = new Map<string, { id: string; name: string; mimeType: string }>([
    ["VSCodeSyncFiles", { id: "ROOT", name: "VSCodeSyncFiles", mimeType: "application/vnd.google-apps.folder" }],
    ["ws1", { id: "WS", name: "ws1", mimeType: "application/vnd.google-apps.folder" }],
    ["src", { id: "SRC", name: "src", mimeType: "application/vnd.google-apps.folder" }],
    ["a.ts", { id: "FILE", name: "a.ts", mimeType: "text/plain" }],
  ]);

  it("files.update c addParents/removeParents и новым именем; etag = md5Checksum", async () => {
    let patchUrl = "";
    let patchBody = "";
    globalThis.fetch = routedFetch([
      (url) => {
        const m = /q=([^&]+)/.exec(url);
        if (m && url.includes("/files?q=")) {
          const q = decodeURIComponent(m[1]);
          const name = /name='([^']+)'/.exec(q)?.[1] ?? "";
          const hit = CHILD_BY_NAME.get(name);
          return json({ files: hit ? [hit] : [] });
        }
        return undefined;
      },
      (url, init) => {
        if (url.endsWith("/files") && init?.method === "POST") {
          const body = JSON.parse(bodyText(init)) as { name: string };
          return json({ id: `NEW-${body.name}` });
        }
        return undefined;
      },
      (url, init) => {
        if (url.includes("/files/FILE?") && init?.method === "PATCH") {
          patchUrl = url;
          patchBody = bodyText(init);
          return json({ id: "FILE", md5Checksum: "md5x" });
        }
        return undefined;
      },
    ]);
    const p = await makeProvider();
    const res = await p.moveFile("VSCodeSyncFiles/ws1/src/a.ts", "VSCodeSyncFiles/ws1/lib/moved.ts");
    expect(res.etag).toBe("md5x");
    expect(patchUrl).toContain("addParents=NEW-lib");
    expect(patchUrl).toContain("removeParents=SRC");
    expect(JSON.parse(patchBody)).toEqual({ name: "moved.ts" });
  });

  it("источник не найден → ProviderError NOT_FOUND без PATCH", async () => {
    globalThis.fetch = routedFetch([
      (url) => {
        const m = /q=([^&]+)/.exec(url);
        if (m && url.includes("/files?q=")) {
          const q = decodeURIComponent(m[1]);
          const name = /name='([^']+)'/.exec(q)?.[1] ?? "";
          const hit = name === "gone.ts" ? undefined : CHILD_BY_NAME.get(name);
          return json({ files: hit ? [hit] : [] });
        }
        return undefined;
      },
    ]);
    const p = await makeProvider();
    await expect(p.moveFile("VSCodeSyncFiles/ws1/src/gone.ts", "VSCodeSyncFiles/ws1/lib/b.ts")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("OneDriveProvider.moveFile", () => {
  async function makeProvider(): Promise<OneDriveProvider> {
    const secrets = memSecrets();
    await secrets.store(
      secretKeyForProvider("onedrive"),
      JSON.stringify({ accessToken: "t", refreshToken: "r", expiresAtMs: Date.now() + 3600_000 }),
    );
    return new OneDriveProvider(secrets);
  }

  it("PATCH driveItem c parentReference.id после createFolder; etag из ответа", async () => {
    let patchBody = "";
    globalThis.fetch = routedFetch([
      (url, init) => (url.includes("/children") && init?.method === "POST" ? json({}) : undefined),
      (url, init) =>
        url.endsWith("/me/drive/root:/VSCodeSyncFiles/ws1/lib:") && (init?.method ?? "GET") === "GET"
          ? json({ id: "P1" })
          : undefined,
      (url, init) => {
        if (url.endsWith("/me/drive/root:/VSCodeSyncFiles/ws1/src/a.ts:") && init?.method === "PATCH") {
          patchBody = bodyText(init);
          return json({ id: "X", eTag: '"e9"' });
        }
        return undefined;
      },
    ]);
    const p = await makeProvider();
    const res = await p.moveFile("VSCodeSyncFiles/ws1/src/a.ts", "VSCodeSyncFiles/ws1/lib/b.ts");
    expect(res.etag).toBe("e9");
    expect(JSON.parse(patchBody)).toEqual({ parentReference: { id: "P1" }, name: "b.ts" });
  });

  it("404 на PATCH → ProviderError NOT_FOUND", async () => {
    globalThis.fetch = routedFetch([
      (url, init) => (url.includes("/children") && init?.method === "POST" ? json({}) : undefined),
      (url, init) =>
        url.endsWith(":") && (init?.method ?? "GET") === "GET" ? json({ id: "P1" }) : undefined,
      (_url, init) => (init?.method === "PATCH" ? new Response("", { status: 404 }) : undefined),
    ]);
    const p = await makeProvider();
    await expect(p.moveFile("VSCodeSyncFiles/ws1/src/gone.ts", "VSCodeSyncFiles/ws1/lib/b.ts")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("wrapWithQueue пробрасывает moveFile", () => {
  it("провайдер с moveFile сохраняет его за обёрткой; без — undefined", async () => {
    const mock = new MockCloudProvider("onedrive");
    await mock.uploadFile("VSCodeSyncFiles/ws1/a.ts", Buffer.from("x"));
    const wrapped = wrapWithQueue(mock);
    expect(typeof wrapped.moveFile).toBe("function");
    await wrapped.moveFile!("VSCodeSyncFiles/ws1/a.ts", "VSCodeSyncFiles/ws1/b.ts");
    await expect(mock.downloadFile("VSCodeSyncFiles/ws1/b.ts")).resolves.toBeDefined();

    // A provider that never had moveFile must not grow a broken stub.
    const bare = new MockCloudProvider("gdrive");
    Object.defineProperty(bare, "moveFile", { value: undefined });
    const wrappedBare = wrapWithQueue(bare);
    expect(typeof wrappedBare.moveFile).toBe("undefined");
  });
});

describe("relocateBlobsForMoves: фолбэк при падении нативного move", () => {
  it("ошибка moveFile → транскод-копия, _meta переезжает, старый блоб в списке на удаление", async () => {
    class FailingMove extends MockCloudProvider {
      override moveFile(): Promise<never> {
        return Promise.reject(new Error("native move broken"));
      }
    }
    const provider = new FailingMove("onedrive");
    const ws = "ws1";
    const from = "src/a.ts";
    const to = "lib/b.ts";
    await provider.uploadFile(blobCloudPath(ws, from, false), Buffer.from("content-1"));
    const meta: MetaJson = {
      files: {
        [from]: { hash: "h-old", etag: "e-old", version: 1, machineId: "M1", updatedAt: "2026-01-01T00:00:00.000Z" },
      },
    };
    const oldPaths = await relocateBlobsForMoves({
      workspaceId: ws,
      provider,
      moves: [{ from, to }],
      meta,
      nowIso: "2026-08-12T00:00:00.000Z",
      machineId: "M1",
      decode: (b) => b,
      encodeFor: (rel, plaintext) => ({ body: plaintext, wireGzip: false, cloudPath: blobCloudPath(ws, rel, false) }),
      hashFor: (_plaintext, rel) => `h-${rel}`,
    });
    expect(oldPaths).toEqual([blobCloudPath(ws, from, false)]);
    const moved = await provider.downloadFile(blobCloudPath(ws, to, false));
    expect(moved.body.toString()).toBe("content-1");
    expect(meta.files[to]?.hash).toBe(`h-${to}`);
    expect(meta.files[from]).toBeUndefined();
  });
});
