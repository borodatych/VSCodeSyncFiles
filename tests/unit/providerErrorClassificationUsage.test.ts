/**
 * HTTP responses become `ProviderError` in exactly one place (E1).
 *
 * The four providers used to throw `NETWORK_ERROR` from 48 sites and
 * `UNAUTHORIZED` from two, so a revoked token read as "no connection" and the
 * offline queue retried it forever. The classifier fixed that; this gate stops
 * the next hand-written `throw new ProviderError("NETWORK_ERROR", await r.text())`
 * from quietly reopening it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..", "src", "providers");

const PROVIDER_FILES = [
  "gdrive/gdriveProvider.ts",
  "dropbox/dropboxProvider.ts",
  "onedrive/onedriveProvider.ts",
  "yandex/yandexDiskProvider.ts",
];

/** `throw new ProviderError(<code>, await <resp>.text())` — the old shape. */
const RAW_RESPONSE_THROW = /new ProviderError\(\s*"[A-Z_]+"\s*,\s*await\s+\w+\.text\(\)/;

describe("классификация ошибок провайдеров: одна точка", () => {
  it("ни один провайдер не строит ошибку прямо из тела ответа", () => {
    const offenders: string[] = [];
    for (const rel of PROVIDER_FILES) {
      const text = readFileSync(join(SRC, rel), "utf8");
      if (RAW_RESPONSE_THROW.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("каждый провайдер подключён к общему классификатору", () => {
    const missing: string[] = [];
    for (const rel of PROVIDER_FILES) {
      const text = readFileSync(join(SRC, rel), "utf8");
      if (!text.includes("classifyProviderHttpError")) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });

  it("у каждого провайдера есть принудительный refresh по 401", () => {
    const missing: string[] = [];
    for (const rel of PROVIDER_FILES) {
      const text = readFileSync(join(SRC, rel), "utf8");
      // Yandex keeps its own 401 branch (it signs requests with `OAuth`, not
      // `Bearer`, so the shared helper does not fit); the rest use the helper.
      const wired =
        text.includes("sendWithForcedRefreshOn401") || text.includes("if (r.status === 401)");
      if (!wired) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });
});
