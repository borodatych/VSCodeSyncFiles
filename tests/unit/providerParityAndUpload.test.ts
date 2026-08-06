/**
 * E6, E7, E10, E13 — chunked uploads, content digests and provider parity.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { parseNextExpectedOffset } from "../../src/providers/onedrive/onedriveProvider.js";
import { planDropboxUpload } from "../../src/core/dropboxUploadSessionPlanner.js";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { DropboxProvider } from "../../src/providers/dropbox/dropboxProvider.js";
import { storeDropboxTokens } from "../../src/providers/dropbox/dropboxTokens.js";
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

describe("OneDrive: возобновление upload-сессии (E6)", () => {
  it("пустой список диапазонов → начинаем с нуля", () => {
    expect(parseNextExpectedOffset(undefined)).toBe(0);
    expect(parseNextExpectedOffset([])).toBe(0);
  });

  it("берём наименьшее начало из nextExpectedRanges", () => {
    expect(parseNextExpectedOffset(["26214400-"])).toBe(26214400);
    expect(parseNextExpectedOffset(["100-200", "50-99"])).toBe(50);
  });

  it("неразбираемый ответ → 0 (перезалить безопасно, продолжить с догадки — нет)", () => {
    expect(parseNextExpectedOffset(["мусор"])).toBe(0);
    expect(parseNextExpectedOffset(["-500"])).toBe(0);
  });
});

describe("Dropbox: план сессионной заливки (E7)", () => {
  it("маленький файл — одним запросом", () => {
    expect(planDropboxUpload(1024).singleShot).toBe(true);
  });

  it("большой файл разбивается на start / append_v2 / finish", () => {
    const plan = planDropboxUpload(200 * 1024 * 1024);
    expect(plan.singleShot).toBe(false);
    expect(plan.chunks[0]?.endpoint).toBe("start");
    expect(plan.chunks.at(-1)?.endpoint).toBe("finish");
    expect(plan.chunks.filter((c) => c.endpoint === "append_v2").length).toBeGreaterThan(0);
    // Чанки покрывают файл целиком и без нахлёста.
    const total = plan.chunks.reduce((s, c) => s + c.length, 0);
    expect(total).toBe(plan.totalBytes);
    let expectedOffset = 0;
    for (const c of plan.chunks) {
      expect(c.offset).toBe(expectedOffset);
      expectedOffset += c.length;
    }
  });
});

describe("Dropbox: parity (E13)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("getWebViewLink возвращает ссылку (раньше метода не было вовсе)", async () => {
    const secrets = memSecrets();
    await storeDropboxTokens(secrets, {
      accessToken: "t",
      refreshToken: "r",
      expiresAtMs: Date.now() + 3600_000,
    });
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ url: "https://www.dropbox.com/s/abc/file.ts" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const p = new DropboxProvider(secrets, () => "app-key");
    await expect(p.getWebViewLink("VSCodeSyncFiles/ws/a.ts")).resolves.toBe(
      "https://www.dropbox.com/s/abc/file.ts",
    );
  });
});

describe("contentDigest как отдельное поле (E10)", () => {
  it("мок-провайдер не выдумывает дайджест, если его нет", async () => {
    const provider = new MockCloudProvider("onedrive");
    await provider.uploadFile("p/a.txt", Buffer.from("hi", "utf8"));
    const meta = await provider.getMetadata("p/a.txt");
    // Поле опциональное: провайдер без дайджеста просто его не заполняет,
    // и проверка целостности пропускается, а не гадает по etag.
    expect(meta?.contentDigest).toBeUndefined();
    expect(typeof meta?.etag).toBe("string");
  });
});
