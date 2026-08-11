/**
 * Link Bindings — duplicate detection at add time (docs/v2/linkBindings.md,
 * stage 2). Advisory matcher: content hash beats name, tombstones never reach
 * the index (caller filters), maps keep bulk adds O(N+M).
 */
import { describe, expect, it } from "vitest";
import { planAddDuplicates, type CloudIndexRow } from "../../src/core/plan/planAddDuplicates.js";

const index: CloudIndexRow[] = [
  { path: "promed/api/user.php", linkName: "user.php", hash: "H-USER" },
  { path: "docs/readme.md", hash: "H-README" },
  { path: "named/entry.ts", linkName: "Моя метка", hash: "H-ENTRY" },
  { path: "no-meta/thing.txt" },
];

describe("planAddDuplicates", () => {
  it("совпадение контента находит запись при другом имени и пути", () => {
    const out = planAddDuplicates([{ posixRel: "local/renamed.php", hash: "H-USER" }], index);
    expect(out).toEqual([
      { posixRel: "local/renamed.php", cloudPath: "promed/api/user.php", cloudLinkName: "user.php", kind: "content" },
    ]);
  });

  it("контент и имя на одной записи → content+name", () => {
    const out = planAddDuplicates([{ posixRel: "elsewhere/user.php", hash: "H-USER" }], index);
    expect(out[0]?.kind).toBe("content+name");
  });

  it("совпадение только имени (basename или linkName, регистронезависимо)", () => {
    expect(planAddDuplicates([{ posixRel: "x/README.md", hash: "H-OTHER" }], index)[0]?.kind).toBe("name");
    expect(planAddDuplicates([{ posixRel: "x/моя метка", hash: "H-OTHER" }], index)[0]?.kind).toBe("name");
  });

  it("контент важнее имени: hash одной записи + имя другой → content по hash-записи", () => {
    const out = planAddDuplicates([{ posixRel: "x/readme.md", hash: "H-USER" }], index);
    expect(out[0]).toMatchObject({ cloudPath: "promed/api/user.php", kind: "content" });
  });

  it("нет совпадений или нечитаемый файл без совпадения имени → пусто", () => {
    expect(planAddDuplicates([{ posixRel: "x/unique.rs", hash: "H-NEW" }], index)).toEqual([]);
    expect(planAddDuplicates([{ posixRel: "x/unique.rs", hash: "" }], index)).toEqual([]);
  });

  it("запись без hash в meta матчится по имени, но не по пустому контенту", () => {
    expect(planAddDuplicates([{ posixRel: "y/thing.txt", hash: "" }], index)[0]?.kind).toBe("name");
  });
});
