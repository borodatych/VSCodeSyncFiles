/**
 * Tests for `detectMassChange` — guards against accidental large-scale
 * deletions before they hit cloud manifests.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_ABSOLUTE_THRESHOLD,
  DEFAULT_PERCENT_THRESHOLD,
  describeMassChange,
  detectMassChange,
} from "../../src/core/massChangeGuard.js";
import type { CloudManifest, ManifestFile } from "../../src/core/cloudLayout.js";

function file(path: string, removed = false): ManifestFile {
  return {
    path,
    addedAt: "2026-04-01T00:00:00.000Z",
    version: 1,
    hasSyncignoreMarkers: false,
    ...(removed ? { removedAt: "2026-05-01T00:00:00.000Z" } : {}),
  };
}

function manifest(files: ManifestFile[]): CloudManifest {
  return {
    schemaVersion: 1,
    workspaceId: "ws",
    workspaceNote: "note",
    providerType: "onedrive",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    files,
    machines: [],
    tags: [],
  };
}

describe("detectMassChange", () => {
  it("not triggered without a prev manifest (initial push)", () => {
    const r = detectMassChange(undefined, manifest([file("a")]));
    expect(r.triggered).toBe(false);
  });

  it("not triggered when nothing is removed", () => {
    const prev = manifest([file("a"), file("b")]);
    const next = manifest([file("a"), file("b"), file("c")]);
    expect(detectMassChange(prev, next).triggered).toBe(false);
  });

  it("triggers on absolute threshold (≥ 25 by default)", () => {
    const prevFiles = Array.from({ length: 30 }, (_, i) => file(`f${String(i)}`));
    const nextFiles = prevFiles.slice(0, 4);
    const r = detectMassChange(manifest(prevFiles), manifest(nextFiles));
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe("absolute");
    expect(r.newlyRemoved.length).toBe(26);
  });

  it("triggers on percent threshold (≥ 50% by default)", () => {
    const prevFiles = Array.from({ length: 10 }, (_, i) => file(`f${String(i)}`));
    const nextFiles = prevFiles.slice(0, 4); // remove 6/10 = 60%
    const r = detectMassChange(manifest(prevFiles), manifest(nextFiles));
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe("percent");
  });

  it("does not trigger below both thresholds", () => {
    const prevFiles = Array.from({ length: 10 }, (_, i) => file(`f${String(i)}`));
    const nextFiles = prevFiles.slice(0, 8); // remove 2/10 = 20% < 50%
    const r = detectMassChange(manifest(prevFiles), manifest(nextFiles));
    expect(r.triggered).toBe(false);
  });

  it("counts a tombstoned file (removedAt set) the same as a missing one", () => {
    const prev = manifest([file("a"), file("b"), file("c"), file("d"), file("e")]);
    const next = manifest([
      file("a"),
      file("b"),
      file("c", true),
      file("d", true),
      file("e", true),
    ]);
    const r = detectMassChange(prev, next, { percentThreshold: 0.5 });
    expect(r.triggered).toBe(true);
    expect(r.newlyRemoved.sort()).toEqual(["c", "d", "e"]);
  });

  it("respects custom thresholds", () => {
    const prev = manifest([file("a"), file("b"), file("c")]);
    const next = manifest([file("a")]);
    expect(
      detectMassChange(prev, next, { absoluteThreshold: 1 }).triggered,
    ).toBe(true);
    expect(
      detectMassChange(prev, next, { absoluteThreshold: 100, percentThreshold: 0.99 }).triggered,
    ).toBe(false);
  });

  it("default constants are sensible", () => {
    expect(DEFAULT_ABSOLUTE_THRESHOLD).toBe(25);
    expect(DEFAULT_PERCENT_THRESHOLD).toBe(0.5);
  });
});

describe("describeMassChange", () => {
  it("empty when not triggered", () => {
    expect(describeMassChange({ triggered: false, newlyRemoved: [], previousActiveCount: 0 })).toBe(
      "",
    );
  });

  it("formats absolute reason", () => {
    expect(
      describeMassChange({
        triggered: true,
        reason: "absolute",
        newlyRemoved: new Array<string>(30).fill("x"),
        previousActiveCount: 50,
      }),
    ).toMatch(/30 файлов/);
  });

  it("formats percent reason with %", () => {
    expect(
      describeMassChange({
        triggered: true,
        reason: "percent",
        newlyRemoved: new Array<string>(6).fill("x"),
        previousActiveCount: 10,
      }),
    ).toMatch(/60%/);
  });
});

describe("detectMassChange — rename-осведомлённость", () => {
  // Канонический переезд = tombstone + наследник. Без этих веток каждый
  // папочный rename ≥25 файлов ловил бы модалку «массовое удаление».
  const stamp = "2026-08-12T00:00:00.000Z";

  it("tombstone с наследником по renamedFrom — не удаление", () => {
    const prevFiles = Array.from({ length: 30 }, (_, i) => file(`src/f${String(i)}.ts`));
    const nextFiles = [
      ...prevFiles.map((f) => ({ ...f, removedAt: stamp })),
      ...prevFiles.map((f) => ({
        ...file(`lib/f${f.path.slice(4)}`),
        renamedFrom: f.path,
        renamedAt: stamp,
      })),
    ];
    const r = detectMassChange(manifest(prevFiles), manifest(nextFiles));
    expect(r.triggered).toBe(false);
    expect(r.newlyRemoved).toEqual([]);
  });

  it("идентичность жива под другим путём (linkId) — не удаление даже без renamedFrom", () => {
    const prevFiles = Array.from({ length: 30 }, (_, i) => ({
      ...file(`src/f${String(i)}.ts`),
      linkId: `id${String(i).padStart(14, "0")}`,
    }));
    const nextFiles = prevFiles.map((f) => ({
      ...f,
      path: `lib/${f.path.slice(4)}`,
    }));
    const r = detectMassChange(manifest(prevFiles), manifest(nextFiles));
    expect(r.triggered).toBe(false);
  });

  it("настоящие удаления по-прежнему триггерят гард", () => {
    const prevFiles = Array.from({ length: 30 }, (_, i) => file(`src/f${String(i)}.ts`));
    const nextFiles = prevFiles.map((f) => ({ ...f, removedAt: stamp }));
    const r = detectMassChange(manifest(prevFiles), manifest(nextFiles));
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe("absolute");
  });
});
