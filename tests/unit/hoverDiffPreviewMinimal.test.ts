import { describe, expect, it } from "vitest";
import { summariseHoverDiffMinimal } from "../../src/core/hoverDiffPreview.js";

const NOW = Date.parse("2026-05-08T12:00:00.000Z");
const min = (n: number): number => NOW - n * 60_000;

describe("summariseHoverDiffMinimal", () => {
  it("renders cloud_newer with age + machine + Pull hint", () => {
    const text = summariseHoverDiffMinimal({
      relPath: "a.ts",
      syncStatus: "cloud_newer",
      lastSyncAtMs: min(5),
      lastSyncByMachine: "alpha",
      nowMs: NOW,
    });
    expect(text).toContain("Облачная версия новее");
    expect(text).toContain("5 мин назад");
    expect(text).toContain("alpha");
    expect(text).toContain("Pull");
  });

  it("renders conflict with Resolve hint", () => {
    const text = summariseHoverDiffMinimal({
      relPath: "a.ts",
      syncStatus: "conflict",
      lastSyncAtMs: min(60),
      lastSyncByMachine: "beta",
      nowMs: NOW,
    });
    expect(text).toContain("Конфликт");
    expect(text).toContain("Resolve");
    expect(text).toContain("beta");
  });

  it("renders ok status with age", () => {
    const text = summariseHoverDiffMinimal({
      relPath: "a.ts",
      syncStatus: "ok",
      lastSyncAtMs: min(2 * 60),
      lastSyncByMachine: "gamma",
      nowMs: NOW,
    });
    expect(text).toContain("Синхронизирован");
    expect(text).toContain("2 ч назад");
    expect(text).toContain("gamma");
  });

  it("falls back to «ещё не синхронизирован» when lastSyncAtMs is null", () => {
    const text = summariseHoverDiffMinimal({
      relPath: "a.ts",
      syncStatus: "cloud_newer",
      lastSyncAtMs: null,
      lastSyncByMachine: "alpha",
      nowMs: NOW,
    });
    expect(text).toContain("ещё не синхронизирован");
  });

  it("omits machine parenthetical when machine is empty", () => {
    const text = summariseHoverDiffMinimal({
      relPath: "a.ts",
      syncStatus: "ok",
      lastSyncAtMs: min(1),
      lastSyncByMachine: "",
      nowMs: NOW,
    });
    expect(text).not.toMatch(/\([^)]*\)/);
  });

  it("renders «только что» for sub-minute and zero age", () => {
    const a = summariseHoverDiffMinimal({
      relPath: "a.ts",
      syncStatus: "ok",
      lastSyncAtMs: NOW - 30_000,
      lastSyncByMachine: "x",
      nowMs: NOW,
    });
    expect(a).toContain("только что");
  });

  it("renders day-scale ages", () => {
    const text = summariseHoverDiffMinimal({
      relPath: "a.ts",
      syncStatus: "ok",
      lastSyncAtMs: NOW - 3 * 24 * 3600_000,
      lastSyncByMachine: "x",
      nowMs: NOW,
    });
    expect(text).toContain("3 дн назад");
  });
});
