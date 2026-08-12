/**
 * Folder intake preview (docs/v2/linkBindings.md). Real case: cloud carries
 * `php/**`, this machine wants it under `promed/**` with the same structure
 * inside.
 */
import { describe, expect, it } from "vitest";
import { describeFolderIntake, planFolderIntake } from "../../src/core/plan/planFolderIntake.js";

const manifestPaths = [
  "php/modules/di_config.php",
  "php/modules/Repository.php",
  "php/core/BaseEntity.php",
  "jscore/Forms4/formStyle.js", // другая папка — не должна попасть
];

describe("planFolderIntake", () => {
  it("маппит облачный префикс в локальный, чужие папки не трогает", () => {
    const plan = planFolderIntake({
      canonicalPrefix: "php",
      localPrefix: "promed",
      manifestPaths,
      localPaths: [],
    });
    expect(plan.total).toBe(3);
    // Порядок человеческий (localeCompare), а не ASCII: di_config перед Repository.
    expect(plan.rows.map((r) => r.local)).toEqual([
      "promed/core/BaseEntity.php",
      "promed/modules/di_config.php",
      "promed/modules/Repository.php",
    ]);
    expect(plan.identity).toBe(false);
  });

  it("«как есть»: канон совпадает с локальным — identity, пути не меняются", () => {
    const plan = planFolderIntake({
      canonicalPrefix: "jscore",
      localPrefix: "jscore",
      manifestPaths,
      localPaths: [],
    });
    expect(plan.identity).toBe(true);
    expect(plan.rows[0]).toMatchObject({ canonical: "jscore/Forms4/formStyle.js", local: "jscore/Forms4/formStyle.js" });
  });

  it("считает совпадение структуры и помечает коллизии вместо тихой перезаписи", () => {
    const plan = planFolderIntake({
      canonicalPrefix: "php",
      localPrefix: "promed",
      manifestPaths,
      localPaths: ["promed/modules/di_config.php"],
      trackedLocalPaths: ["promed/core/BaseEntity.php"],
    });
    expect(plan.matchedCount).toBe(1);
    expect(plan.collisions.map((r) => r.local).sort()).toEqual([
      "promed/core/BaseEntity.php",
      "promed/modules/di_config.php",
    ]);
    expect(plan.rows.find((r) => r.local === "promed/modules/di_config.php")?.collides).toBe(true);
    expect(plan.rows.find((r) => r.local === "promed/core/BaseEntity.php")?.takenByOtherRow).toBe(true);
  });

  it("слэши по краям префиксов нормализуются", () => {
    const plan = planFolderIntake({
      canonicalPrefix: "/php/",
      localPrefix: "/promed/",
      manifestPaths,
      localPaths: [],
    });
    expect(plan.rows[0]?.local.startsWith("promed/")).toBe(true);
  });

  it("предпросмотр ограничен и честно считает остаток", () => {
    const many = Array.from({ length: 25 }, (_, i) => `php/f${String(i).padStart(2, "0")}.php`);
    const plan = planFolderIntake({
      canonicalPrefix: "php",
      localPrefix: "promed",
      manifestPaths: many,
      localPaths: [],
      previewLimit: 3,
    });
    expect(plan.preview).toHaveLength(3);
    const text = describeFolderIntake(plan);
    expect(text).toContain("Файлов: 25");
    expect(text).toContain("…и ещё 22");
  });

  it("пустая облачная папка описывается словами, а не пустым блоком", () => {
    const plan = planFolderIntake({
      canonicalPrefix: "nope",
      localPrefix: "here",
      manifestPaths,
      localPaths: [],
    });
    expect(plan.total).toBe(0);
    expect(describeFolderIntake(plan)).toBe("В этой облачной папке нет файлов.");
  });
});
