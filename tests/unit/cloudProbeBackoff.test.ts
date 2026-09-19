/**
 * Фоновые пробы недоступного облака: разрежение вместо долбёжки раз в минуту.
 *
 * Повод — рабочий день 18–19.09.2026: облако резалось на периметре, каждая
 * попытка висела 10 с (connect timeout undici), и опросники продолжали заводить
 * новую каждую минуту. 147 отказов, ни одного полезного ответа.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  noteCloudTransportFailure,
  noteCloudTransportSuccess,
  resetOfflineHintsForTests,
} from "../../src/core/syncOfflineHints.js";
import {
  cloudProbeAllowedNow,
  msUntilNextCloudProbe,
  resetCloudProbeBackoffForTests,
  setCloudProbeBackoffListener,
} from "../../src/core/cloudProbeBackoff.js";

afterEach(() => {
  resetCloudProbeBackoffForTests();
  resetOfflineHintsForTests();
});

describe("cloudProbeBackoff", () => {
  it("пока облако отвечает, пробы разрешены всегда", () => {
    expect(cloudProbeAllowedNow()).toBe(true);
    expect(msUntilNextCloudProbe()).toBe(0);
  });

  it("первый транспортный отказ откладывает пробы на 15 с", () => {
    noteCloudTransportFailure();
    expect(cloudProbeAllowedNow()).toBe(false);
    const wait = msUntilNextCloudProbe();
    expect(wait).toBeGreaterThan(14_000);
    expect(wait).toBeLessThanOrEqual(15_000);
  });

  it("серия отказов одного эпизода не двигает задержку трижды", () => {
    noteCloudTransportFailure();
    const afterFirst = msUntilNextCloudProbe();
    // Три попытки внутри одного withRetry приходят подряд, в пределах секунд.
    noteCloudTransportFailure();
    noteCloudTransportFailure();
    expect(msUntilNextCloudProbe()).toBeLessThanOrEqual(afterFirst);
  });

  it("успех возвращает обычный режим немедленно", () => {
    noteCloudTransportFailure();
    expect(cloudProbeAllowedNow()).toBe(false);
    noteCloudTransportSuccess();
    expect(cloudProbeAllowedNow()).toBe(true);
    expect(msUntilNextCloudProbe()).toBe(0);
  });

  it("сообщает о входе в разрежённый режим и о выходе из него", () => {
    const events: { unreachable: boolean; nextMs: number }[] = [];
    setCloudProbeBackoffListener((unreachable, nextProbeInMs) => {
      events.push({ unreachable, nextMs: nextProbeInMs });
    });
    noteCloudTransportFailure();
    noteCloudTransportSuccess();
    expect(events.map((e) => e.unreachable)).toEqual([true, false]);
    expect(events[0]?.nextMs).toBeGreaterThan(0);
  });

  it("проба в разрешённый момент не блокируется задним числом", () => {
    noteCloudTransportFailure();
    const future = Date.now() + 20_000;
    expect(cloudProbeAllowedNow(future)).toBe(true);
  });
});
