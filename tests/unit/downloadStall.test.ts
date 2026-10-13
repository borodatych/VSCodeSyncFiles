/**
 * Зависшее скачивание обрывается по простою, а не по общему потолку.
 *
 * Повод: 22 скачивания с Яндекс.Диска подряд ждали по 120 с тело, которое не
 * шло, и каждое объявляло недоступным всё облако.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchTimeoutError, fetchWithTimeout } from "../../src/providers/_shared/fetchWithTimeout.js";
import { isConnectLevelFailure } from "../../src/core/transportFailureReason.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Ответ, чьё тело отдаёт `chunks` и затем молчит, пока запрос не оборвут. */
function stubFetch(chunks: Uint8Array[], thenClose: boolean): void {
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        if (thenClose) {
          controller.close();
          return;
        }
        init.signal?.addEventListener("abort", () => {
          controller.error(new Error("aborted"));
        });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  });
}

describe("fetchWithTimeout: простой", () => {
  it("тело молчит — обрыв по простою задолго до потолка", async () => {
    stubFetch([new Uint8Array([1, 2])], false);
    const started = Date.now();
    await expect(
      fetchWithTimeout("https://x.test/disk/a", {}, { channel: "t", timeoutMs: 60_000, idleTimeoutMs: 40 }),
    ).rejects.toBeInstanceOf(FetchTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("живое тело дочитывается целиком", async () => {
    stubFetch([new Uint8Array([1, 2]), new Uint8Array([3])], true);
    const r = await fetchWithTimeout("https://x.test/disk/a", {}, {
      channel: "t",
      timeoutMs: 60_000,
      idleTimeoutMs: 500,
    });
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("isConnectLevelFailure", () => {
  const withCode = (code: string): Error =>
    new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code }) });

  it("нет соединения — облако недоступно", () => {
    expect(isConnectLevelFailure(withCode("UND_ERR_CONNECT_TIMEOUT"))).toBe(true);
    expect(isConnectLevelFailure(withCode("ENOTFOUND"))).toBe(true);
  });

  it("зависшее тело и таймаут ответа — сбой одного файла, а не облака", () => {
    expect(isConnectLevelFailure(new FetchTimeoutError(20_000, "GET a"))).toBe(false);
    expect(isConnectLevelFailure(withCode("ETIMEDOUT"))).toBe(false);
    expect(isConnectLevelFailure(withCode("ECONNRESET"))).toBe(false);
  });
});
