/**
 * Шкала конфликтов — детерминированно.
 *
 * Прежняя версия брала «сейчас» из системных часов внутри функции, а тест
 * пользовался вбитыми майскими датами. Пока разница не превысила окно в
 * 90 дней, всё было зелено; потом тест начал падать сам по себе, без единой
 * правки кода. Теперь «сейчас» передаётся явно — календарь на результат
 * больше не влияет.
 */
import { describe, expect, it } from "vitest";
import { buildConflictHeatmapTimeline } from "../../src/core/conflictHeatmapTimeline.js";

/** Фиксированное «сейчас» для всех проверок окна. */
const NOW_MS = Date.parse("2026-05-23T00:00:00Z");

describe("buildConflictHeatmapTimeline", () => {
  it("пустой вход → пустая шкала", () => {
    const t = buildConflictHeatmapTimeline({ events: [], nowMs: NOW_MS });
    expect(t.buckets).toEqual([]);
    expect(t.peak).toBeNull();
    expect(t.total).toBe(0);
  });

  it("группирует события по дням", () => {
    const t = buildConflictHeatmapTimeline({
      nowMs: NOW_MS,
      events: [
        { atIso: "2026-05-21T10:00:00Z", posixRel: "a" },
        { atIso: "2026-05-21T20:00:00Z", posixRel: "a" },
        { atIso: "2026-05-22T01:00:00Z", posixRel: "b" },
      ],
    });
    expect(t.buckets).toHaveLength(2);
    expect(t.buckets[0]?.dayIso).toBe("2026-05-21");
    expect(t.buckets[0]?.count).toBe(2);
    expect(t.buckets[1]?.dayIso).toBe("2026-05-22");
  });

  it("находит пиковый день", () => {
    const t = buildConflictHeatmapTimeline({
      nowMs: NOW_MS,
      events: [
        { atIso: "2026-05-21T10:00:00Z", posixRel: "a" },
        { atIso: "2026-05-22T01:00:00Z", posixRel: "b" },
        { atIso: "2026-05-22T02:00:00Z", posixRel: "c" },
        { atIso: "2026-05-22T03:00:00Z", posixRel: "d" },
      ],
    });
    expect(t.peak?.dayIso).toBe("2026-05-22");
    expect(t.peak?.count).toBe(3);
  });

  it("топ файлов внутри дня отсортирован по числу событий", () => {
    const t = buildConflictHeatmapTimeline({
      nowMs: NOW_MS,
      events: [
        { atIso: "2026-05-21T10:00:00Z", posixRel: "popular" },
        { atIso: "2026-05-21T10:00:00Z", posixRel: "popular" },
        { atIso: "2026-05-21T10:00:00Z", posixRel: "popular" },
        { atIso: "2026-05-21T11:00:00Z", posixRel: "rare" },
      ],
    });
    expect(t.buckets[0]?.topFiles[0]?.posixRel).toBe("popular");
    expect(t.buckets[0]?.topFiles[0]?.count).toBe(3);
  });

  it("учитывает явное окно fromIso", () => {
    const t = buildConflictHeatmapTimeline({
      nowMs: NOW_MS,
      events: [
        { atIso: "2026-04-01T00:00:00Z", posixRel: "old" },
        { atIso: "2026-05-21T00:00:00Z", posixRel: "new" },
      ],
      fromIso: "2026-05-01T00:00:00Z",
    });
    expect(t.total).toBe(1);
  });

  it("по умолчанию отбрасывает события старше 90 дней от «сейчас»", () => {
    const t = buildConflictHeatmapTimeline({
      nowMs: NOW_MS,
      events: [
        { atIso: "2025-11-01T00:00:00Z", posixRel: "ancient" },
        { atIso: "2026-05-21T00:00:00Z", posixRel: "recent" },
      ],
    });
    expect(t.total).toBe(1);
    expect(t.buckets[0]?.topFiles[0]?.posixRel).toBe("recent");
  });

  it("соблюдает ограничение topPerBucket", () => {
    const t = buildConflictHeatmapTimeline({
      nowMs: NOW_MS,
      events: [
        { atIso: "2026-05-21T10:00:00Z", posixRel: "a" },
        { atIso: "2026-05-21T11:00:00Z", posixRel: "b" },
        { atIso: "2026-05-21T12:00:00Z", posixRel: "c" },
      ],
      topPerBucket: 2,
    });
    expect(t.buckets[0]?.topFiles).toHaveLength(2);
  });

  it("пропускает битые отметки времени", () => {
    const t = buildConflictHeatmapTimeline({
      nowMs: NOW_MS,
      events: [
        { atIso: "not-a-date", posixRel: "bad" },
        { atIso: "2026-05-21T00:00:00Z", posixRel: "good" },
      ],
    });
    expect(t.total).toBe(1);
  });
});
