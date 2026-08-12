/**
 * Canonical-root choice when sending a folder (docs/v2/linkBindings.md).
 * Real case: home `src/SEMD272/jscore/**` must land in the cloud as
 * `jscore/**`, so the work machine gets the paths it actually uses.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalKeyUnderRoot,
  planCanonicalRootOptions,
} from "../../src/core/plan/planCanonicalRoot.js";

describe("planCanonicalRootOptions", () => {
  it("предлагает срезать префикс по сегментам, «как есть» первым", () => {
    const opts = planCanonicalRootOptions({
      localDirRel: "src/SEMD272/jscore",
      sampleLocalPath: "src/SEMD272/jscore/Forms4/Common/formStyle.js",
    });
    expect(opts.map((o) => o.canonicalRoot)).toEqual(["src/SEMD272/jscore", "SEMD272/jscore", "jscore"]);
    expect(opts.map((o) => o.droppedPrefix)).toEqual(["", "src", "src/SEMD272"]);
    // Образец показывает, как будет выглядеть ключ файла в облаке.
    expect(opts[2]?.sampleCanonicalPath).toBe("jscore/Forms4/Common/formStyle.js");
  });

  it("однокорневая папка даёт единственный вариант", () => {
    expect(planCanonicalRootOptions({ localDirRel: "php" })).toEqual([
      { droppedPrefix: "", canonicalRoot: "php", sampleCanonicalPath: "php" },
    ]);
  });

  it("пустой путь — вариантов нет", () => {
    expect(planCanonicalRootOptions({ localDirRel: "" })).toEqual([]);
    expect(planCanonicalRootOptions({ localDirRel: "///" })).toEqual([]);
  });

  it("образец вне отправляемой папки не подставляется", () => {
    const opts = planCanonicalRootOptions({ localDirRel: "php", sampleLocalPath: "other/x.php" });
    expect(opts[0]?.sampleCanonicalPath).toBe("php");
  });
});

describe("canonicalKeyUnderRoot", () => {
  it("переносит хвост под выбранный канонический корень", () => {
    expect(
      canonicalKeyUnderRoot(
        "src/SEMD272/jscore",
        "jscore",
        "src/SEMD272/jscore/Forms4/Common/formStyle.js",
      ),
    ).toBe("jscore/Forms4/Common/formStyle.js");
  });

  it("«как есть» ничего не меняет", () => {
    expect(canonicalKeyUnderRoot("php", "php", "php/modules/di_config.php")).toBe("php/modules/di_config.php");
  });

  it("файл вне папки и пустые префиксы → undefined", () => {
    expect(canonicalKeyUnderRoot("php", "promed", "other/x.php")).toBeUndefined();
    expect(canonicalKeyUnderRoot("", "promed", "php/x.php")).toBeUndefined();
    expect(canonicalKeyUnderRoot("php", "", "php/x.php")).toBeUndefined();
  });

  it("похожее имя папки не матчится (php2 ≠ php)", () => {
    expect(canonicalKeyUnderRoot("php", "promed", "php2/x.php")).toBeUndefined();
  });
});
