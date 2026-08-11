/**
 * Link Bindings — binding self-heal planner (docs/v2/linkBindings.md, stage 3):
 * re-assert this machine's placements that a v1 row-LWW merge dropped from the
 * cloud copy. The local config is authoritative for the machine's own binding.
 */
import { describe, expect, it } from "vitest";
import type { ManifestFile } from "../../src/core/cloudLayout.js";
import { planBindingSelfHeal } from "../../src/core/plan/planBindingSelfHeal.js";
import type { TrackedFile } from "../../src/core/types.js";

const row = (over: Partial<ManifestFile>): ManifestFile => ({
  path: "promed/a.php",
  addedAt: "t0",
  version: 3,
  hasSyncignoreMarkers: false,
  ...over,
});

const tracked = (over: Partial<TrackedFile>): TrackedFile => ({
  localPath: "php/a.php",
  workspaceId: "ws1",
  cloudPath: "c",
  lastSync: "t",
  localHash: "h",
  manifestPath: "promed/a.php",
  ...over,
});

const base = {
  machineId: "M-home",
  folderRules: undefined,
  nextVersion: 10,
  nowIso: "t9",
};

describe("planBindingSelfHeal", () => {
  it("пере-утверждает потерянную привязку с bump версии", () => {
    const { healedRows } = planBindingSelfHeal({
      ...base,
      trackedFiles: [tracked({})],
      manifestFiles: [row({})], // v1 merge dropped bindings entirely
    });
    const healed = healedRows.get("promed/a.php");
    expect(healed?.bindings).toEqual({ "M-home": { path: "php/a.php", boundAt: "t9" } });
    expect(healed?.version).toBe(10);
  });

  it("облако уже согласно / файл не привязан / строки нет или tombstone → ничего", () => {
    const agree = planBindingSelfHeal({
      ...base,
      trackedFiles: [tracked({})],
      manifestFiles: [row({ bindings: { "M-home": { path: "php/a.php", boundAt: "t1" } } })],
    });
    expect(agree.healedRows.size).toBe(0);
    const unbound = planBindingSelfHeal({
      ...base,
      trackedFiles: [tracked({ manifestPath: undefined, localPath: "promed/a.php" })],
      manifestFiles: [row({})],
    });
    expect(unbound.healedRows.size).toBe(0);
    const gone = planBindingSelfHeal({
      ...base,
      trackedFiles: [tracked({})],
      manifestFiles: [row({ removedAt: "t5" })],
    });
    expect(gone.healedRows.size).toBe(0);
  });

  it("размещение, объяснённое папочным правилом, не порождает по-файловой привязки", () => {
    const { healedRows } = planBindingSelfHeal({
      ...base,
      folderRules: { promed: { path: "php", boundAt: "t1" } },
      trackedFiles: [tracked({})],
      manifestFiles: [row({})],
    });
    expect(healedRows.size).toBe(0);
  });

  it("чужой ключ с другим путём не мешает и сохраняется победой union-merge (правится только свой)", () => {
    const { healedRows } = planBindingSelfHeal({
      ...base,
      trackedFiles: [tracked({})],
      manifestFiles: [row({ bindings: { "M-work": { path: "w/a.php", boundAt: "t2" } } })],
    });
    const healed = healedRows.get("promed/a.php");
    expect(healed?.bindings?.["M-work"]).toEqual({ path: "w/a.php", boundAt: "t2" });
    expect(healed?.bindings?.["M-home"]?.path).toBe("php/a.php");
  });
});
