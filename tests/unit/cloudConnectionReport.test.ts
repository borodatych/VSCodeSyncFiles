/**
 * Вердикт команды «Проверить связь с облаком».
 */
import { describe, expect, it } from "vitest";
import {
  adviceForCloudConnectionVerdict,
  describeCloudConnectionVerdict,
  verdictForCloudProbe,
} from "../../src/core/cloudConnectionReport.js";

function undiciError(code: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code }) });
}

describe("verdictForCloudProbe", () => {
  it("быстрый ответ — связь в порядке", () => {
    const v = verdictForCloudProbe({ provider: "Yandex Disk", elapsedMs: 240 });
    expect(v.kind).toBe("ok");
    expect(describeCloudConnectionVerdict(v)).toContain("240 мс");
  });

  it("ответ дольше трёх секунд отмечается как медленный", () => {
    const v = verdictForCloudProbe({ provider: "Dropbox", elapsedMs: 4_200 });
    expect(v.kind).toBe("slow");
    expect(adviceForCloudConnectionVerdict(v)).toContain("щадящий");
  });

  it("отказ токена не путается с обрывом сети", () => {
    const v = verdictForCloudProbe({
      provider: "OneDrive",
      elapsedMs: 120,
      errorCode: "UNAUTHORIZED",
      error: new Error("401"),
    });
    expect(v.kind).toBe("unauthorized");
    expect(describeCloudConnectionVerdict(v)).toContain("повторный вход");
  });

  it("ограничение частоты называет срок повтора", () => {
    const v = verdictForCloudProbe({
      provider: "Google Drive",
      elapsedMs: 80,
      errorCode: "RATE_LIMITED",
      error: new Error("429"),
      retryAfterMs: 12_000,
    });
    expect(describeCloudConnectionVerdict(v)).toContain("12 с");
  });

  it("connect timeout объясняется блокировкой периметра", () => {
    const v = verdictForCloudProbe({
      provider: "Yandex Disk",
      elapsedMs: 10_400,
      error: undiciError("UND_ERR_CONNECT_TIMEOUT"),
    });
    expect(v.kind).toBe("unreachable");
    expect(describeCloudConnectionVerdict(v)).not.toContain("fetch failed");
    expect(adviceForCloudConnectionVerdict(v)).toContain("периметре");
  });

  it("мёртвый DNS получает свой совет, а не общий", () => {
    const v = verdictForCloudProbe({
      provider: "Yandex Disk",
      elapsedMs: 9,
      error: undiciError("ENOTFOUND"),
    });
    expect(adviceForCloudConnectionVerdict(v)).toContain("DNS");
  });

  it("без провайдера проверять нечего", () => {
    expect(describeCloudConnectionVerdict({ kind: "no_provider" })).toContain("вход не выполнен");
  });
});
