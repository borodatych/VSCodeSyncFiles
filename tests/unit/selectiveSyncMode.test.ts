/**
 * Selective sync verdict + mode-switch preview.
 *
 * The load-bearing property: the preview and the engine must agree, because
 * they call the same `shouldSyncUnderMode` over the same parsed rules. A
 * preview computed by a second matcher would be a promise the sync pass does
 * not keep.
 */
import { describe, expect, it } from "vitest";
import { parseIgnoreRules } from "../../src/utils/ignoreMatch.js";
import {
  parseSelectiveSyncMode,
  scoreModeSwitch,
  shouldSyncUnderMode,
  summariseModeSwitch,
} from "../../src/core/selectiveSyncMode.js";

const rules = parseIgnoreRules(["secrets/", "*.local.json"].join("\n"));
const tracked = [
  "src/app.ts",
  "src/util.ts",
  "secrets/token.txt",
  "config.local.json",
];

describe("parseSelectiveSyncMode", () => {
  it("неизвестное и отсутствующее значение — самый безопасный режим", () => {
    expect(parseSelectiveSyncMode(undefined)).toBe("all-tracked");
    expect(parseSelectiveSyncMode("мусор")).toBe("all-tracked");
    expect(parseSelectiveSyncMode("include-list")).toBe("include-list");
    expect(parseSelectiveSyncMode("exclude-list")).toBe("exclude-list");
  });
});

describe("shouldSyncUnderMode", () => {
  it("all-tracked синхронизирует всё, даже совпавшее с паттернами", () => {
    for (const rel of tracked) {
      expect(shouldSyncUnderMode(rel, rules, "all-tracked")).toBe(true);
    }
  });

  it("exclude-list убирает совпавшее", () => {
    expect(shouldSyncUnderMode("src/app.ts", rules, "exclude-list")).toBe(true);
    expect(shouldSyncUnderMode("secrets/token.txt", rules, "exclude-list")).toBe(false);
    expect(shouldSyncUnderMode("config.local.json", rules, "exclude-list")).toBe(false);
  });

  it("include-list оставляет только совпавшее", () => {
    expect(shouldSyncUnderMode("src/app.ts", rules, "include-list")).toBe(false);
    expect(shouldSyncUnderMode("secrets/token.txt", rules, "include-list")).toBe(true);
  });

  it("пустой список правил не выключает синхронизацию ни в одном режиме", () => {
    for (const mode of ["all-tracked", "exclude-list", "include-list"] as const) {
      expect(shouldSyncUnderMode("src/app.ts", [], mode)).toBe(true);
    }
  });
});

describe("summariseModeSwitch", () => {
  it("переход all-tracked → exclude-list останавливает совпавшие", () => {
    const impact = summariseModeSwitch({
      trackedRelPaths: tracked,
      rules,
      prevMode: "all-tracked",
      nextMode: "exclude-list",
    });
    expect(impact.wouldStop.sort()).toEqual(["config.local.json", "secrets/token.txt"]);
    expect(impact.wouldStart).toEqual([]);
    expect(impact.unchangedCount).toBe(2);
  });

  it("переход exclude-list → include-list переворачивает смысл каждой строки", () => {
    const impact = summariseModeSwitch({
      trackedRelPaths: tracked,
      rules,
      prevMode: "exclude-list",
      nextMode: "include-list",
    });
    expect(impact.wouldStop.sort()).toEqual(["src/app.ts", "src/util.ts"]);
    expect(impact.wouldStart.sort()).toEqual(["config.local.json", "secrets/token.txt"]);
    expect(impact.unchangedCount).toBe(0);
  });

  it("одинаковый режим — ничего не меняется", () => {
    const impact = summariseModeSwitch({
      trackedRelPaths: tracked,
      rules,
      prevMode: "exclude-list",
      nextMode: "exclude-list",
    });
    expect(scoreModeSwitch(impact)).toBe("noop");
  });
});

describe("scoreModeSwitch", () => {
  it("массовая остановка требует более строгого диалога", () => {
    const many = Array.from({ length: 10 }, (_, i) => `f${String(i)}.ts`);
    expect(scoreModeSwitch({ wouldStop: many, wouldStart: [], unchangedCount: 0 })).toBe("danger");
    expect(scoreModeSwitch({ wouldStop: ["a.ts"], wouldStart: [], unchangedCount: 3 })).toBe("warn");
    expect(scoreModeSwitch({ wouldStop: [], wouldStart: ["a.ts"], unchangedCount: 3 })).toBe("info");
    expect(scoreModeSwitch({ wouldStop: [], wouldStart: [], unchangedCount: 3 })).toBe("noop");
  });
});
