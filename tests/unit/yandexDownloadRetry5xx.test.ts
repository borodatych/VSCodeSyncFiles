/**
 * Скачивание с Яндекс.Диска: ответ 5xx хранилища повторяется по свежей ссылке, 4xx — нет.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  YandexDiskProvider,
  isRetryableDownloadStatus,
} from "../../src/providers/yandex/yandexDiskProvider.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";
import { storeYandexTokens } from "../../src/providers/yandex/yandexTokens.js";
import type { SecretStore } from "../../src/core/types.js";

const CLOUD_PATH = "/Settings/a.json";
const STORAGE_URL = "https://downloader.example/file";

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

describe("isRetryableDownloadStatus", () => {
  it("повторяет только 5xx", () => {
    expect(isRetryableDownloadStatus(500)).toBe(true);
    expect(isRetryableDownloadStatus(599)).toBe(true);
    expect(isRetryableDownloadStatus(404)).toBe(false);
    expect(isRetryableDownloadStatus(429)).toBe(false);
    expect(isRetryableDownloadStatus(200)).toBe(false);
  });
});

describe("YandexDiskProvider — повтор скачивания при 5xx", () => {
  let originalFetch: typeof globalThis.fetch;
  let storageAnswers: Response[];
  let linkRequests: number;
  let storageRequests: number;
  let provider: YandexDiskProvider;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    linkRequests = 0;
    storageRequests = 0;
    storageAnswers = [];
    const secrets = memSecrets();
    await storeYandexTokens(secrets, { accessToken: "tok", expiresAtMs: Date.now() + 3600_000 });
    provider = new YandexDiskProvider(secrets, () => "client-id");
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(STORAGE_URL)) {
        storageRequests++;
        return Promise.resolve(storageAnswers.shift() ?? new Response("", { status: 500 }));
      }
      if (url.includes("resources/download")) {
        linkRequests++;
        return Promise.resolve(new Response(JSON.stringify({ href: STORAGE_URL }), { status: 200 }));
      }
      // getMetadata после успешной загрузки
      return Promise.resolve(new Response(JSON.stringify({ md5: "m", modified: "2026-01-01T00:00:00Z" }), { status: 200 }));
    }) satisfies typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("500, затем 200 — файл получен по новой ссылке", async () => {
    storageAnswers = [new Response("file IO failure", { status: 500 }), new Response("data", { status: 200 })];
    const res = await provider.downloadFile(CLOUD_PATH);
    expect(res.body.toString()).toBe("data");
    expect(linkRequests).toBe(2);
    expect(storageRequests).toBe(2);
  });

  it("три 500 подряд — ошибка с облачным путём и кодом сервера", async () => {
    storageAnswers = [500, 500, 500].map((s) => new Response("no more reliable hosts", { status: s }));
    const err = await provider.downloadFile(CLOUD_PATH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toContain(CLOUD_PATH);
    expect((err as ProviderError).code).toBe("SERVER_ERROR");
    expect(storageRequests).toBe(3);
  });

  it("404 — без повтора", async () => {
    storageAnswers = [new Response("", { status: 404 })];
    const err = await provider.downloadFile(CLOUD_PATH).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("NOT_FOUND");
    expect(storageRequests).toBe(1);
  });
});
