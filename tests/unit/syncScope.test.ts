/**
 * Sync scope (docs/v2/linkBindings.md): the per-machine choice of which
 * canonical folders this disk carries.
 */
import { describe, expect, it } from "vitest";
import { isInSyncScope, normalizeScopePrefix, normalizeSyncScopes } from "../../src/core/syncScope.js";

describe("isInSyncScope", () => {
  it("пустой scope пропускает всё — конфиги до фичи работают без изменений", () => {
    expect(isInSyncScope(undefined, "jscore/a.js")).toBe(true);
    expect(isInSyncScope([], "promed/modules/x.php")).toBe(true);
  });

  it("префикс покрывает саму папку и всё под ней", () => {
    expect(isInSyncScope(["jscore"], "jscore")).toBe(true);
    expect(isInSyncScope(["jscore"], "jscore/Forms4/formStyle.js")).toBe(true);
    expect(isInSyncScope(["jscore"], "promed/modules/x.php")).toBe(false);
  });

  it("сосед с общим началом имени не попадает (php ≠ php2)", () => {
    expect(isInSyncScope(["php"], "php2/x.php")).toBe(false);
    expect(isInSyncScope(["php"], "php/x.php")).toBe(true);
  });

  it("несколько префиксов — объединение", () => {
    const scopes = ["jscore", "promed/modules"];
    expect(isInSyncScope(scopes, "promed/modules/di_config.php")).toBe(true);
    expect(isInSyncScope(scopes, "promed/core/BaseEntity.php")).toBe(false);
  });

  it("слэши по краям не влияют на совпадение", () => {
    expect(isInSyncScope(["/jscore/"], "jscore/a.js")).toBe(true);
  });
});

describe("normalizeSyncScopes", () => {
  it("схлопывает вложенные префиксы и дубликаты", () => {
    expect(normalizeSyncScopes(["jscore", "jscore/Forms4", "jscore", "promed"])).toEqual([
      "jscore",
      "promed",
    ]);
  });

  it("выбрасывает пустые значения и нормализует слэши", () => {
    expect(normalizeSyncScopes(["", "/php/", "  ".trim()])).toEqual(["php"]);
  });

  it("несвязанные ветки сохраняются обе", () => {
    expect(normalizeSyncScopes(["a/b", "a/c"])).toEqual(["a/b", "a/c"]);
  });
});

describe("normalizeScopePrefix", () => {
  it("срезает ведущие и хвостовые слэши", () => {
    expect(normalizeScopePrefix("/a/b/")).toBe("a/b");
  });
});
