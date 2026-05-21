import { describe, expect, it } from "vitest";
import {
  buildSyncProfileReport,
  createSyncProfileBuffer,
} from "../../src/core/syncProfileBuffer.js";
import type { SyncProfileSample } from "../../src/core/syncEngine.js";

function sample(rel: string, totalMs: number, kind: "push" | "pull" = "push"): SyncProfileSample {
  return {
    kind,
    workspaceId: "ws-1",
    posixRel: rel,
    bytes: 4096,
    totalMs,
    hashMs: 5,
    networkMs: Math.max(0, totalMs - 10),
    verifyMs: 5,
  };
}

describe("syncProfileBuffer", () => {
  it("FIFO drop after capacity", () => {
    const buf = createSyncProfileBuffer({ capacity: 10 });
    for (let i = 0; i < 25; i++) buf.push(sample(`f${String(i)}`, i));
    const snap = buf.snapshot();
    expect(snap.length).toBe(10);
    expect(snap[0]?.posixRel).toBe("f15");
    expect(snap[9]?.posixRel).toBe("f24");
  });

  it("buildSyncProfileReport: empty buffer → hint", () => {
    const out = buildSyncProfileReport([]);
    expect(out[0]).toMatch(/нет образцов/);
  });

  it("buildSyncProfileReport: sorts by avg total ms desc", () => {
    const samples: SyncProfileSample[] = [
      sample("file-aaa.ts", 100),
      sample("file-bbb.ts", 500),
      sample("file-ccc.ts", 50),
    ];
    const out = buildSyncProfileReport(samples, 3);
    const fileLines = out.filter((l) => l.includes("file-"));
    expect(fileLines).toHaveLength(3);
    expect(fileLines[0]).toContain("file-bbb.ts");
    expect(fileLines[1]).toContain("file-aaa.ts");
    expect(fileLines[2]).toContain("file-ccc.ts");
  });

  it("aggregates multiple samples of same file", () => {
    const samples: SyncProfileSample[] = [
      sample("file-aaa.ts", 100),
      sample("file-aaa.ts", 200),
      sample("file-aaa.ts", 300),
    ];
    const out = buildSyncProfileReport(samples, 5);
    const aLine = out.find((l) => l.includes("file-aaa.ts"));
    expect(aLine).toBeDefined();
    // averaged total ms = 200
    expect(aLine).toContain("200");
    expect(aLine).toContain("3×");
  });
});
