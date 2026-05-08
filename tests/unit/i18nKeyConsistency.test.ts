import { describe, expect, it } from "vitest";
import {
  extractI18nKeyReferences,
  validateI18nConsistency,
} from "../../src/core/i18nKeyConsistency.js";

describe("extractI18nKeyReferences", () => {
  it("collects keys from whole-string %key% placeholders only", () => {
    const sample = {
      title: "%cmd.foo.title%",
      label: "Plain text",
      configuration: {
        properties: {
          "vscodesync.x": { description: "%cfg.x.description%" },
        },
      },
    };
    const keys = extractI18nKeyReferences(sample);
    expect([...keys].sort()).toEqual(["cfg.x.description", "cmd.foo.title"]);
  });

  it("ignores partial placeholders inside other text", () => {
    const sample = { mixed: "Click %cmd.x.title% to start" };
    expect(extractI18nKeyReferences(sample).size).toBe(0);
  });

  it("walks arrays recursively", () => {
    const sample = {
      menus: [
        { command: "x", title: "%a%" },
        { command: "y", title: "%b%" },
      ],
    };
    expect([...extractI18nKeyReferences(sample)].sort()).toEqual(["a", "b"]);
  });
});

describe("validateI18nConsistency — coverage and issues", () => {
  const refs = new Set(["cmd.a", "cmd.b", "cfg.c"]);

  it("reports 100% coverage when every reference resolves", () => {
    const r = validateI18nConsistency({
      referencedKeys: refs,
      nlsDefault: new Map([
        ["cmd.a", "A"],
        ["cmd.b", "B"],
        ["cfg.c", "C"],
      ]),
      nlsLocale: new Map([
        ["cmd.a", "А"],
        ["cmd.b", "Б"],
        ["cfg.c", "В"],
      ]),
      localeName: "ru",
    });
    expect(r.defaultCoverage).toBe(1);
    expect(r.localeCoverage).toBe(1);
    expect(r.issues).toEqual([]);
  });

  it("flags missing_in_default when default NLS lacks a referenced key", () => {
    const r = validateI18nConsistency({
      referencedKeys: refs,
      nlsDefault: new Map([
        ["cmd.a", "A"],
        ["cfg.c", "C"],
      ]),
      nlsLocale: new Map([
        ["cmd.a", "А"],
        ["cmd.b", "Б"],
        ["cfg.c", "В"],
      ]),
      localeName: "ru",
    });
    const missing = r.issues.find((i) => i.kind === "missing_in_default");
    expect(missing?.key).toBe("cmd.b");
  });

  it("flags missing_in_locale when locale NLS lacks a referenced key", () => {
    const r = validateI18nConsistency({
      referencedKeys: refs,
      nlsDefault: new Map([
        ["cmd.a", "A"],
        ["cmd.b", "B"],
        ["cfg.c", "C"],
      ]),
      nlsLocale: new Map([
        ["cmd.a", "А"],
        ["cfg.c", "В"],
      ]),
      localeName: "ru",
    });
    const missing = r.issues.find((i) => i.kind === "missing_in_locale");
    expect(missing?.key).toBe("cmd.b");
  });

  it("flags unused_in_default when NLS has stale keys", () => {
    const r = validateI18nConsistency({
      referencedKeys: new Set(["cmd.a"]),
      nlsDefault: new Map([
        ["cmd.a", "A"],
        ["cmd.dead", "Dead"],
      ]),
      nlsLocale: new Map([["cmd.a", "А"]]),
      localeName: "ru",
    });
    expect(r.issues.find((i) => i.kind === "unused_in_default")?.key).toBe("cmd.dead");
  });

  it("flags unused_in_locale separately from default", () => {
    const r = validateI18nConsistency({
      referencedKeys: new Set(["cmd.a"]),
      nlsDefault: new Map([["cmd.a", "A"]]),
      nlsLocale: new Map([
        ["cmd.a", "А"],
        ["cmd.dead", "М"],
      ]),
      localeName: "ru",
    });
    expect(r.issues.find((i) => i.kind === "unused_in_locale")?.key).toBe("cmd.dead");
  });

  it("flags empty_translation for whitespace-only values", () => {
    const r = validateI18nConsistency({
      referencedKeys: new Set(["cmd.a"]),
      nlsDefault: new Map([["cmd.a", "A"]]),
      nlsLocale: new Map([["cmd.a", "   "]]),
      localeName: "ru",
    });
    const empty = r.issues.find((i) => i.kind === "empty_translation");
    expect(empty?.detail).toContain("ru");
  });

  it("returns 1.0 coverage on empty inputs (avoids 0/0)", () => {
    const r = validateI18nConsistency({
      referencedKeys: new Set<string>(),
      nlsDefault: new Map(),
      nlsLocale: new Map(),
      localeName: "ru",
    });
    expect(r.defaultCoverage).toBe(1);
    expect(r.localeCoverage).toBe(1);
  });
});
