import { describe, expect, it, beforeEach } from "vitest";
import {
  inspectProviderResponse,
  providerTransportError,
} from "../../src/providers/_shared/providerFetchOutcome.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";
import {
  bumpOfflineFlushBackoff,
  canAttemptOfflineFlushNow,
  resetOfflineFlushBackoff,
} from "../../src/core/syncOfflineFlushBackoff.js";

const res = (status: number, body = ""): Response => new Response(body, { status });

describe("inspectProviderResponse", () => {
  beforeEach(() => {
    resetOfflineFlushBackoff();
  });

  it("успех сбрасывает глобальный оффлайн-бэкофф (E12)", async () => {
    bumpOfflineFlushBackoff();
    expect(canAttemptOfflineFlushNow()).toBe(false);
    await inspectProviderResponse(res(200, "ok"), "P");
    expect(canAttemptOfflineFlushNow()).toBe(true);
  });

  it("троттлинг Google в виде 403 доходит до ретрая (E8)", async () => {
    await expect(
      inspectProviderResponse(
        res(403, '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}'),
        "Google Drive",
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("переполнение бросается и не ретраится как 5xx (E9)", async () => {
    await expect(
      inspectProviderResponse(
        res(403, '{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}'),
        "Google Drive",
      ),
    ).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED" });
    await expect(inspectProviderResponse(res(507), "Yandex Disk")).rejects.toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
    });
  });

  it("5xx и 401 бросаются, 404/412 отдаются вызывающему", async () => {
    await expect(inspectProviderResponse(res(500), "P")).rejects.toMatchObject({
      code: "SERVER_ERROR",
    });
    await expect(inspectProviderResponse(res(401), "P")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(inspectProviderResponse(res(404), "P")).resolves.toMatchObject({ status: 404 });
    await expect(inspectProviderResponse(res(412), "P")).resolves.toMatchObject({ status: 412 });
  });

  it("423 (Yandex locked) отдаётся вызывающему — его 423-цикл продолжает работать", async () => {
    await expect(inspectProviderResponse(res(423), "Yandex Disk")).resolves.toMatchObject({
      status: 423,
    });
  });

  it("тело остаётся читаемым после разбора", async () => {
    const r = await inspectProviderResponse(res(404, "gone"), "P");
    await expect(r.text()).resolves.toBe("gone");
  });
});

describe("providerTransportError", () => {
  beforeEach(() => {
    resetOfflineFlushBackoff();
  });

  it("не трогает глобальный бэкофф (E12: бампает операция, не транспорт)", () => {
    providerTransportError(new Error("ECONNRESET"), "P");
    expect(canAttemptOfflineFlushNow()).toBe(true);
  });

  it("уже классифицированную ошибку пропускает как есть", () => {
    const e = new ProviderError("UNAUTHORIZED", "dead");
    expect(providerTransportError(e, "P")).toBe(e);
  });

  it("сырую ошибку заворачивает в NETWORK_ERROR", () => {
    const e = providerTransportError(new Error("boom"), "Dropbox");
    expect(e.code).toBe("NETWORK_ERROR");
    expect(e.message).toContain("Dropbox");
  });
});
