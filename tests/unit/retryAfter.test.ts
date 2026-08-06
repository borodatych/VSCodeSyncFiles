import { describe, expect, it } from "vitest";
import {
  parseRetryAfterToDelayMs,
  RETRY_AFTER_MAX_DELAY_MS,
} from "../../src/utils/retryAfter.js";

describe("parseRetryAfterToDelayMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterToDelayMs("42", 0, 300_000)).toBe(42_000);
  });

  it("caps delay", () => {
    expect(parseRetryAfterToDelayMs("9999", 0, 50_000)).toBe(50_000);
  });

  it("parses HTTP-date in the future", () => {
    const now = Date.UTC(2026, 3, 29, 12, 0, 0);
    const future = new Date(now + 30_000).toUTCString();
    expect(parseRetryAfterToDelayMs(future, now, 300_000)).toBe(30_000);
  });

  it("returns undefined for empty or invalid", () => {
    expect(parseRetryAfterToDelayMs(null)).toBeUndefined();
    expect(parseRetryAfterToDelayMs("")).toBeUndefined();
    expect(parseRetryAfterToDelayMs("not-a-date")).toBeUndefined();
  });

  it("clamps HTTP-date in the past to 0 (server saying retry now)", () => {
    const now = Date.UTC(2026, 3, 29, 12, 0, 0);
    const past = new Date(now - 30_000).toUTCString();
    expect(parseRetryAfterToDelayMs(past, now, 300_000)).toBe(0);
  });

  it("rejects mixed-format strings (digits with letters)", () => {
    expect(parseRetryAfterToDelayMs("60s")).toBeUndefined();
    expect(parseRetryAfterToDelayMs("0x10")).toBeUndefined();
  });

  it("HTTP-date in the very-far future is capped to maxDelay", () => {
    const now = Date.UTC(2026, 3, 29, 12, 0, 0);
    const yearAway = new Date(now + 365 * 24 * 3600_000).toUTCString();
    expect(parseRetryAfterToDelayMs(yearAway, now, 60_000)).toBe(60_000);
  });

  it("дефолтный потолок — минута, а не пять", () => {
    // Пять минут в связке с тремя попытками и 120-секундным таймаутом запроса
    // давали до ~16 минут на один вызов провайдера, а отменить его было нечем:
    // для пользователя это неотличимо от зависания.
    expect(RETRY_AFTER_MAX_DELAY_MS).toBe(60_000);
    expect(parseRetryAfterToDelayMs("600", 0)).toBe(RETRY_AFTER_MAX_DELAY_MS);
  });

  it("значение в пределах потолка отдаётся как есть", () => {
    expect(parseRetryAfterToDelayMs("30", 0)).toBe(30_000);
  });
});
