import { describe, expect, it } from "vitest";
import {
  describeGoHomeVerdict,
  planGoHomePreflight,
  type PreflightFile,
} from "../../src/core/goHomePreflightPlanner.js";

describe("goHomePreflightPlanner — F8", () => {
  const f = (path: string, syncStatus?: string): PreflightFile => ({
    workspaceId: "w1",
    localPath: path,
    syncStatus,
  });

  it("clean when all synced", () => {
    const v = planGoHomePreflight([f("a.ts"), f("b.ts"), f("c.ts")]);
    expect(v.kind).toBe("clean");
    if (v.kind === "clean") expect(v.trackedCount).toBe(3);
  });

  it("pending_push only → pending_push verdict with capped list", () => {
    const files = Array.from({ length: 15 }, (_, i) => f(`a${String(i)}.ts`, "pending_push"));
    const v = planGoHomePreflight(files);
    expect(v.kind).toBe("pending_push");
    if (v.kind === "pending_push") {
      expect(v.total).toBe(15);
      expect(v.files).toHaveLength(10);
    }
  });

  it("cloud_newer only", () => {
    const v = planGoHomePreflight([f("a.ts", "cloud_newer"), f("b.ts", "cloud_newer")]);
    expect(v.kind).toBe("cloud_newer");
  });

  it("conflict only", () => {
    const v = planGoHomePreflight([f("a.ts", "conflict")]);
    expect(v.kind).toBe("conflict");
  });

  it("mixed: pending_push + conflict", () => {
    const v = planGoHomePreflight([
      f("a.ts", "pending_push"),
      f("b.ts", "conflict"),
    ]);
    expect(v.kind).toBe("mixed");
    if (v.kind === "mixed") {
      expect(v.pendingPush).toBe(1);
      expect(v.conflicts).toBe(1);
      expect(v.cloudNewer).toBe(0);
    }
  });

  it("describeGoHomeVerdict — все варианты", () => {
    expect(describeGoHomeVerdict({ kind: "clean", trackedCount: 5 })).toMatch(/Можно закрывать/);
    expect(
      describeGoHomeVerdict({ kind: "pending_push", files: [], total: 3 }),
    ).toMatch(/3/);
    expect(
      describeGoHomeVerdict({ kind: "cloud_newer", files: [], total: 2 }),
    ).toMatch(/обновлено/);
    expect(
      describeGoHomeVerdict({ kind: "conflict", files: [], total: 1 }),
    ).toMatch(/конфликт/);
    expect(
      describeGoHomeVerdict({ kind: "mixed", pendingPush: 1, cloudNewer: 2, conflicts: 3 }),
    ).toMatch(/⚠3/);
  });
});
