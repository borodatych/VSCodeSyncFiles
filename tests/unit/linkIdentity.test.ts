/**
 * Link Bindings identity helpers (docs/v2/linkBindings.md). The deterministic
 * backfill is the load-bearing part: two machines backfilling the same legacy
 * row concurrently MUST produce identical ids, and backfill must never touch
 * rows that already carry one.
 */
import { describe, expect, it } from "vitest";
import type { CloudManifest, ManifestFile } from "../../src/core/cloudLayout.js";
import {
  LINK_ID_HEX_LENGTH,
  defaultLinkName,
  deterministicLinkId,
  newLinkId,
  withBackfilledLinkIds,
  withPrunedStaleBindings,
} from "../../src/core/linkIdentity.js";

const row = (over: Partial<ManifestFile>): ManifestFile => ({
  path: "src/a.ts",
  addedAt: "2026-08-11T10:00:00.000Z",
  version: 1,
  hasSyncignoreMarkers: false,
  ...over,
});

const manifest = (files: ManifestFile[], machineIds: string[] = ["M1"]): CloudManifest => ({
  schemaVersion: 1,
  workspaceId: "ws1",
  workspaceNote: "",
  tags: [],
  providerType: "onedrive",
  createdAt: "t0",
  updatedAt: "t0",
  machines: machineIds.map((machineId) => ({ machineId, machineName: machineId, lastSeen: "t0" })),
  files,
});

describe("deterministicLinkId", () => {
  it("стабилен для одинаковых (path, addedAt) — конкурентный бэкфилл сходится", () => {
    expect(deterministicLinkId("src/a.ts", "t0")).toBe(deterministicLinkId("src/a.ts", "t0"));
  });

  it("различает path и addedAt, включая перестановку границы (a+bc vs ab+c)", () => {
    expect(deterministicLinkId("src/a.ts", "t0")).not.toBe(deterministicLinkId("src/b.ts", "t0"));
    expect(deterministicLinkId("src/a.ts", "t0")).not.toBe(deterministicLinkId("src/a.ts", "t1"));
    expect(deterministicLinkId("ab", "c")).not.toBe(deterministicLinkId("a", "bc"));
  });

  it("формат: 16 hex", () => {
    expect(deterministicLinkId("x", "y")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("newLinkId", () => {
  it("формат: 16 hex, значения не повторяются", () => {
    const a = newLinkId();
    expect(a).toMatch(new RegExp(`^[0-9a-f]{${String(LINK_ID_HEX_LENGTH)}}$`));
    expect(newLinkId()).not.toBe(a);
  });
});

describe("defaultLinkName", () => {
  it("basename канонического пути; путь без папок — сам путь", () => {
    expect(defaultLinkName("src/deep/name.ts")).toBe("name.ts");
    expect(defaultLinkName("name.ts")).toBe("name.ts");
  });
});

describe("withBackfilledLinkIds", () => {
  it("copy-on-write: заполняет только отсутствующие (tombstone включительно), исходник не трогает", () => {
    const keep = row({ path: "keep.ts", linkId: "aaaaaaaaaaaaaaaa" });
    const fill = row({ path: "fill.ts" });
    const tomb = row({ path: "tomb.ts", removedAt: "t9" });
    const m = manifest([keep, fill, tomb]);
    const out = withBackfilledLinkIds(m);
    expect(out).not.toBe(m);
    expect(fill.linkId).toBeUndefined(); // source row untouched
    expect(out.files[0]).toBe(keep); // already-filled row shared, not copied
    expect(out.files[1]?.linkId).toBe(deterministicLinkId("fill.ts", fill.addedAt));
    expect(out.files[2]?.linkId).toBe(deterministicLinkId("tomb.ts", tomb.addedAt));
  });

  it("no-op на полностью заполненном манифесте — тот же объект", () => {
    const m = manifest([row({ linkId: "bbbbbbbbbbbbbbbb" })]);
    expect(withBackfilledLinkIds(m)).toBe(m);
  });
});

describe("withPrunedStaleBindings", () => {
  it("выкидывает ключи машин, которых нет в machines[]; пустую карту снимает целиком", () => {
    const bound = row({
      path: "bound.ts",
      linkId: "cccccccccccccccc",
      bindings: {
        M1: { path: "mine/bound.ts", boundAt: "t1" },
        GONE: { path: "old/bound.ts", boundAt: "t0" },
      },
    });
    const orphan = row({
      path: "orphan.ts",
      bindings: { GONE: { path: "x/orphan.ts", boundAt: "t0" } },
    });
    const m = manifest([bound, orphan], ["M1"]);
    const out = withPrunedStaleBindings(m);
    expect(out.files[0]?.bindings).toEqual({ M1: { path: "mine/bound.ts", boundAt: "t1" } });
    expect(out.files[1]?.bindings).toBeUndefined();
    expect(bound.bindings?.GONE).toBeDefined(); // source untouched
  });

  it("no-op без потерянных ключей — тот же объект", () => {
    const m = manifest([row({ bindings: { M1: { path: "a/b.ts", boundAt: "t1" } } })], ["M1"]);
    expect(withPrunedStaleBindings(m)).toBe(m);
  });
});
