import { describe, expect, it } from "vitest";
import {
  classifyProviderHttpError,
  isTerminalProviderErrorCode,
} from "../../src/providers/_shared/classifyHttpError.js";

const code = (status: number, bodyText?: string, retryAfter?: string | null): string =>
  classifyProviderHttpError({ provider: "P", status, bodyText, retryAfter }).code;

describe("classifyProviderHttpError — таблица статусов", () => {
  it("401 → UNAUTHORIZED, 404 → NOT_FOUND, 412/409 → PRECONDITION_FAILED", () => {
    expect(code(401)).toBe("UNAUTHORIZED");
    expect(code(404)).toBe("NOT_FOUND");
    expect(code(410)).toBe("NOT_FOUND");
    expect(code(409)).toBe("PRECONDITION_FAILED");
    expect(code(412)).toBe("PRECONDITION_FAILED");
  });

  it("429/503 → RATE_LIMITED, 5xx → SERVER_ERROR, прочее → NETWORK_ERROR", () => {
    expect(code(429)).toBe("RATE_LIMITED");
    expect(code(503)).toBe("RATE_LIMITED");
    expect(code(500)).toBe("SERVER_ERROR");
    expect(code(502)).toBe("SERVER_ERROR");
    expect(code(418)).toBe("NETWORK_ERROR");
  });

  it("Retry-After попадает в ошибку", () => {
    const e = classifyProviderHttpError({ provider: "P", status: 429, retryAfter: "30" });
    expect(e.retryAfterMs).toBe(30_000);
  });
});

describe("classifyProviderHttpError — тела четырёх API", () => {
  it("Google 403: троттлинг отличается от отказа в доступе", () => {
    expect(code(403, '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}')).toBe(
      "RATE_LIMITED",
    );
    expect(code(403, '{"error":{"errors":[{"reason":"sharingRateLimitExceeded"}]}}')).toBe(
      "RATE_LIMITED",
    );
    expect(code(403, '{"error":{"errors":[{"reason":"insufficientFilePermissions"}]}}')).toBe(
      "UNAUTHORIZED",
    );
  });

  it("переполнение распознаётся раньше 403/5xx", () => {
    expect(code(403, '{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}')).toBe(
      "STORAGE_QUOTA_EXCEEDED",
    );
    expect(code(507)).toBe("STORAGE_QUOTA_EXCEEDED");
    expect(code(409, '{"error_summary":"path/insufficient_space/.."}')).toBe(
      "STORAGE_QUOTA_EXCEEDED",
    );
    expect(code(500, '{"error":{"code":"quotaLimitReached"}}')).toBe("STORAGE_QUOTA_EXCEEDED");
  });

  it("протухший токен виден по телу даже без 401", () => {
    expect(code(400, '{"error":"invalid_grant"}')).toBe("UNAUTHORIZED");
    expect(code(400, '{"error_summary":"expired_access_token/"}')).toBe("UNAUTHORIZED");
    expect(code(400, '{"error":{"code":"InvalidAuthenticationToken"}}')).toBe("UNAUTHORIZED");
  });

  it("сообщение содержит провайдера и обрезанное тело", () => {
    const e = classifyProviderHttpError({ provider: "Dropbox", status: 404, bodyText: "x".repeat(600) });
    expect(e.message.startsWith("Dropbox: не найдено — ")).toBe(true);
    expect(e.message.endsWith("…")).toBe(true);
    expect(e.message.length).toBeLessThan(600);
  });
});

describe("isTerminalProviderErrorCode", () => {
  it("повторять бессмысленно только для терминальных кодов", () => {
    expect(isTerminalProviderErrorCode("UNAUTHORIZED")).toBe(true);
    expect(isTerminalProviderErrorCode("STORAGE_QUOTA_EXCEEDED")).toBe(true);
    expect(isTerminalProviderErrorCode("NOT_FOUND")).toBe(true);
    expect(isTerminalProviderErrorCode("PRECONDITION_FAILED")).toBe(true);
    expect(isTerminalProviderErrorCode("RATE_LIMITED")).toBe(false);
    expect(isTerminalProviderErrorCode("SERVER_ERROR")).toBe(false);
    expect(isTerminalProviderErrorCode("NETWORK_ERROR")).toBe(false);
  });
});
