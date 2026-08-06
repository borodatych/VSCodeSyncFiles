/**
 * Google Drive: reads never create, duplicates resolve deterministically, and
 * deletion is recoverable (B16 / D12 / D11).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GdriveProvider, pickDriveDuplicate } from "../../src/providers/gdrive/gdriveProvider.js";
import { storeGdriveTokens } from "../../src/providers/gdrive/gdriveTokens.js";
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

interface Call {
  url: string;
  method: string;
  body?: string;
}

/** Records every request and answers "no such file" to any Drive query. */
function recordingFetch(calls: Call[], files: () => unknown[]) {
  return vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ files: files() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

describe("Google Drive — чтение не создаёт папки (B16)", () => {
  let secrets: SecretStore;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    secrets = memSecrets();
    await storeGdriveTokens(secrets, {
      accessToken: "valid",
      refreshToken: "r",
      expiresAtMs: Date.now() + 3600_000,
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("listFolder на отсутствующей папке возвращает [] и не делает ни одного POST", async () => {
    const calls: Call[] = [];
    globalThis.fetch = recordingFetch(calls, () => []);
    const p = new GdriveProvider(secrets, () => "client-id");

    await expect(p.listFolder("VSCodeSyncFiles/ws-1")).resolves.toEqual([]);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("getMetadata на отсутствующем пути возвращает null и ничего не создаёт", async () => {
    const calls: Call[] = [];
    globalThis.fetch = recordingFetch(calls, () => []);
    const p = new GdriveProvider(secrets, () => "client-id");

    await expect(p.getMetadata("VSCodeSyncFiles/ws-1/_meta.json")).resolves.toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });
});

describe("pickDriveDuplicate (D12)", () => {
  it("пустой список → null, единственный файл → он сам", () => {
    expect(pickDriveDuplicate([], "x")).toBeNull();
    expect(pickDriveDuplicate([{ id: "b" }], "x")).toEqual({ id: "b" });
  });

  it("дубли имени разрешаются в наименьший id — одинаково на всех машинах", () => {
    const files = [{ id: "zzz" }, { id: "aaa" }, { id: "mmm" }];
    expect(pickDriveDuplicate(files, "_meta.json")).toEqual({ id: "aaa" });
    // Порядок ответа API не влияет на выбор.
    expect(pickDriveDuplicate([...files].reverse(), "_meta.json")).toEqual({ id: "aaa" });
  });
});

describe("Google Drive — удаление в корзину (D11)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("deleteFile делает PATCH {trashed:true}, purgeFilePermanently — DELETE", async () => {
    const secrets = memSecrets();
    await storeGdriveTokens(secrets, {
      accessToken: "valid",
      refreshToken: "r",
      expiresAtMs: Date.now() + 3600_000,
    });
    const calls: Call[] = [];
    // Every lookup resolves to one entry, so the leaf is found.
    globalThis.fetch = recordingFetch(calls, () => [
      { id: "file-1", name: "x", mimeType: "application/vnd.google-apps.folder" },
    ]);
    const p = new GdriveProvider(secrets, () => "client-id");

    await p.deleteFile("VSCodeSyncFiles/ws-1/x");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toContain('"trashed":true');
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    calls.length = 0;
    await p.purgeFilePermanently("VSCodeSyncFiles/ws-1/x");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});
