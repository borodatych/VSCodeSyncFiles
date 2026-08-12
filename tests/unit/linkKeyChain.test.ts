/**
 * Rename-trail chain builder (linkKeyChain.ts) and the chained `.history/`
 * reader: history follows the file through canonical renames, repair victims
 * and path reuse do not graft a stranger's trail.
 */
import { describe, expect, it } from "vitest";
import type { ManifestFile } from "../../src/core/cloudLayout.js";
import { historyDirForFile } from "../../src/core/cloudLayout.js";
import { priorCanonicalKeys } from "../../src/core/linkKeyChain.js";
import {
  historyPathOwnedByChain,
  listHistoryAcrossKeys,
} from "../../src/core/io/historyChainReader.js";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";

function row(partial: Partial<ManifestFile> & { path: string }): ManifestFile {
  return {
    addedAt: "2026-08-01T00:00:00.000Z",
    version: 1,
    hasSyncignoreMarkers: false,
    ...partial,
  };
}

describe("priorCanonicalKeys", () => {
  it("walks a two-step rename trail newest-first", () => {
    const files = [
      row({ path: "c.ts", renamedFrom: "b.ts", linkId: "id1" }),
      row({ path: "b.ts", renamedFrom: "a.ts", removedAt: "2026-08-02T00:00:00.000Z", linkId: "id1" }),
      row({ path: "a.ts", removedAt: "2026-08-01T12:00:00.000Z", linkId: "id1" }),
    ];
    expect(priorCanonicalKeys(files, "c.ts")).toEqual(["b.ts", "a.ts"]);
  });

  it("row without renames has an empty trail; unknown key too", () => {
    const files = [row({ path: "a.ts", linkId: "id1" })];
    expect(priorCanonicalKeys(files, "a.ts")).toEqual([]);
    expect(priorCanonicalKeys(files, "missing.ts")).toEqual([]);
  });

  it("a repair-victim tombstone sharing the linkId is not a rename step", () => {
    const files = [
      row({ path: "live.ts", linkId: "id1" }),
      // repairDuplicateLinkIds tombstoned a losing carrier — no renamedFrom on the live row.
      row({ path: "loser.ts", removedAt: "2026-08-03T00:00:00.000Z", linkId: "id1" }),
    ];
    expect(priorCanonicalKeys(files, "live.ts")).toEqual([]);
  });

  it("keeps a reused chain key but stops following the stranger's trail", () => {
    const files = [
      row({ path: "b.ts", renamedFrom: "a.ts", linkId: "id1" }),
      // The path `a.ts` was reused by an unrelated file with its own history.
      row({ path: "a.ts", renamedFrom: "z.ts", removedAt: "2026-08-05T00:00:00.000Z", linkId: "OTHER" }),
      row({ path: "z.ts", removedAt: "2026-08-04T00:00:00.000Z", linkId: "OTHER" }),
    ];
    expect(priorCanonicalKeys(files, "b.ts")).toEqual(["a.ts"]);
  });

  it("survives a corrupt cycle", () => {
    const files = [
      row({ path: "a.ts", renamedFrom: "b.ts", linkId: "id1" }),
      row({ path: "b.ts", renamedFrom: "a.ts", removedAt: "2026-08-02T00:00:00.000Z", linkId: "id1" }),
    ];
    expect(priorCanonicalKeys(files, "a.ts")).toEqual(["b.ts"]);
  });

  it("prefers the live row when a resumed rename briefly leaves both at one path", () => {
    const files = [
      row({ path: "b.ts", renamedFrom: "a.ts", linkId: "id1" }),
      row({ path: "a.ts", removedAt: "2026-08-02T00:00:00.000Z", linkId: "id1" }),
      // Stale duplicate of the live key from an interrupted batch.
      row({ path: "b.ts", removedAt: "2026-08-01T00:00:00.000Z", linkId: "id1" }),
    ];
    expect(priorCanonicalKeys(files, "b.ts")).toEqual(["a.ts"]);
  });
});

describe("listHistoryAcrossKeys / historyPathOwnedByChain", () => {
  it("merges chain directories newest-first and dedupes", async () => {
    const provider = new MockCloudProvider("onedrive");
    const ws = "ws1";
    await provider.uploadFile(`${historyDirForFile(ws, "new.ts")}/2026-08-12T10-00-00_m1.ts`, Buffer.from("v3"));
    await provider.uploadFile(`${historyDirForFile(ws, "old.ts")}/2026-08-10T10-00-00_m1.ts`, Buffer.from("v1"));
    await provider.uploadFile(`${historyDirForFile(ws, "old.ts")}/2026-08-11T10-00-00_m1.ts`, Buffer.from("v2"));
    const items = await listHistoryAcrossKeys(provider, ws, ["new.ts", "old.ts"]);
    expect(items.map((i) => i.cloudPath.split("/").pop())).toEqual([
      "2026-08-12T10-00-00_m1.ts",
      "2026-08-11T10-00-00_m1.ts",
      "2026-08-10T10-00-00_m1.ts",
    ]);
  });

  it("ownership covers every chain dir and nothing else", () => {
    const ws = "ws1";
    const chain = ["new.ts", "old.ts"];
    expect(historyPathOwnedByChain(ws, chain, `${historyDirForFile(ws, "old.ts")}/x.ts`)).toBe(true);
    expect(historyPathOwnedByChain(ws, chain, `${historyDirForFile(ws, "new.ts")}/x.ts`)).toBe(true);
    expect(historyPathOwnedByChain(ws, chain, `${historyDirForFile(ws, "other.ts")}/x.ts`)).toBe(false);
  });
});
