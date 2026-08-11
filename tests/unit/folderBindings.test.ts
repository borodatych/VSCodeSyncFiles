/**
 * Link Bindings — folder placement rules (docs/v2/linkBindings.md): work
 * `promed/**` ↔ home `php/**` with identical structure inside. Longest prefix
 * wins; resolution is symmetric.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalKeyForLocalPath,
  localPathForCanonicalKey,
  normalizeDirPrefix,
} from "../../src/core/folderBindings.js";

const rules = {
  promed: { path: "php", boundAt: "t1" },
  "promed/vendor/deep": { path: "lib/deep", boundAt: "t2" },
};

describe("normalizeDirPrefix", () => {
  it("срезает ведущие и хвостовые слэши", () => {
    expect(normalizeDirPrefix("/promed/")).toBe("promed");
    expect(normalizeDirPrefix("promed")).toBe("promed");
  });
});

describe("canonicalKeyForLocalPath (локальный → канон)", () => {
  it("маппит файл под локальным префиксом", () => {
    expect(canonicalKeyForLocalPath(rules, "php/api/user.php")).toBe("promed/api/user.php");
  });

  it("самый длинный локальный префикс побеждает", () => {
    expect(canonicalKeyForLocalPath(rules, "lib/deep/x.php")).toBe("promed/vendor/deep/x.php");
  });

  it("вне правил — undefined; сам префикс (не файл под ним) — undefined", () => {
    expect(canonicalKeyForLocalPath(rules, "other/file.php")).toBeUndefined();
    expect(canonicalKeyForLocalPath(rules, "php")).toBeUndefined();
    expect(canonicalKeyForLocalPath(undefined, "php/x.php")).toBeUndefined();
  });

  it("похожее имя папки без слэша не матчится (php2 ≠ php)", () => {
    expect(canonicalKeyForLocalPath(rules, "php2/x.php")).toBeUndefined();
  });
});

describe("localPathForCanonicalKey (канон → локальный)", () => {
  it("маппит новый облачный файл в локальную папку — правило работает на будущее", () => {
    expect(localPathForCanonicalKey(rules, "promed/api/new.php")).toBe("php/api/new.php");
  });

  it("самый длинный канонический префикс побеждает", () => {
    expect(localPathForCanonicalKey(rules, "promed/vendor/deep/y.php")).toBe("lib/deep/y.php");
  });

  it("симметрия: туда и обратно возвращает исходный путь", () => {
    const local = "php/deep/nested/file.php";
    const canon = canonicalKeyForLocalPath(rules, local);
    expect(canon).toBeDefined();
    expect(localPathForCanonicalKey(rules, canon ?? "")).toBe(local);
  });
});
