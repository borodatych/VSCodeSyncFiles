/**
 * Единый регулятор частоты фоновых опросов.
 */
import { describe, expect, it } from "vitest";
import {
  describeBackgroundPollProfile,
  parseBackgroundPollProfile,
  pollIntervalMs,
} from "../../src/core/backgroundPollProfile.js";

describe("parseBackgroundPollProfile", () => {
  it("незнакомое значение — обычный профиль, а не отказ", () => {
    expect(parseBackgroundPollProfile("чепуха")).toBe("normal");
    expect(parseBackgroundPollProfile(undefined)).toBe("normal");
  });

  it("узнаёт все объявленные профили", () => {
    expect(parseBackgroundPollProfile("relaxed")).toBe("relaxed");
    expect(parseBackgroundPollProfile("minimal")).toBe("minimal");
    expect(parseBackgroundPollProfile("off")).toBe("off");
  });
});

describe("pollIntervalMs", () => {
  it("обычный профиль не трогает настроенный интервал", () => {
    expect(pollIntervalMs(30_000, "normal")).toBe(30_000);
  });

  it("щадящий и минимальный разрежают одинаково для всех опросников", () => {
    expect(pollIntervalMs(30_000, "relaxed")).toBe(120_000);
    expect(pollIntervalMs(60_000, "relaxed")).toBe(240_000);
    expect(pollIntervalMs(30_000, "minimal")).toBe(600_000);
  });

  it("относительный ритм опросников сохраняется", () => {
    const probe = pollIntervalMs(30_000, "minimal") ?? 0;
    const presence = pollIntervalMs(60_000, "minimal") ?? 0;
    expect(presence).toBe(probe * 2);
  });

  it("«выключено» не таймер на сутки, а отсутствие таймера", () => {
    expect(pollIntervalMs(30_000, "off")).toBeNull();
  });

  it("каждый профиль объясняется словами", () => {
    for (const p of ["normal", "relaxed", "minimal", "off"] as const) {
      expect(describeBackgroundPollProfile(p).length).toBeGreaterThan(10);
    }
  });
});
