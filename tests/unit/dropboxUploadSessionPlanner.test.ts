import { describe, expect, it } from "vitest";
import { planDropboxUpload } from "../../src/core/dropboxUploadSessionPlanner.js";

const MB = 1024 * 1024;

describe("planDropboxUpload", () => {
  it("small file → single shot", () => {
    const p = planDropboxUpload(10 * MB);
    expect(p.singleShot).toBe(true);
    expect(p.chunks).toEqual([]);
    expect(p.totalBytes).toBe(10 * MB);
  });

  it("file exactly at threshold → single shot", () => {
    const p = planDropboxUpload(150 * MB);
    expect(p.singleShot).toBe(true);
  });

  it("file just above threshold → session with 2 chunks (start+finish)", () => {
    const p = planDropboxUpload(160 * MB);
    expect(p.singleShot).toBe(false);
    // Default chunk = 8 MB; 160/8 = 20 chunks
    expect(p.chunks.length).toBeGreaterThanOrEqual(2);
    expect(p.chunks[0]?.endpoint).toBe("start");
    expect(p.chunks[p.chunks.length - 1]?.endpoint).toBe("finish");
  });

  it("chunk offsets are contiguous and length-accurate", () => {
    const total = 400 * MB;
    const p = planDropboxUpload(total, { chunkBytes: 100 * MB });
    let sum = 0;
    for (const c of p.chunks) sum += c.length;
    expect(sum).toBe(total);
    // First offset = 0
    expect(p.chunks[0]?.offset).toBe(0);
    // Last offset + length = total
    const last = p.chunks[p.chunks.length - 1] as { offset: number; length: number };
    expect(last.offset + last.length).toBe(total);
  });

  it("custom threshold + chunk size", () => {
    const p = planDropboxUpload(20 * MB, { sessionThresholdBytes: 4 * MB, chunkBytes: 4 * MB });
    expect(p.singleShot).toBe(false);
    expect(p.chunks.length).toBe(5);
    expect(p.chunks[0]?.endpoint).toBe("start");
    expect(p.chunks[1]?.endpoint).toBe("append_v2");
    expect(p.chunks[4]?.endpoint).toBe("finish");
  });

  it("collapses to single shot when over threshold but fits one chunk", () => {
    // File > 4 MB threshold, chunk = 100 MB → only 1 chunk → can't be both start AND finish.
    const p = planDropboxUpload(50 * MB, { sessionThresholdBytes: 10 * MB, chunkBytes: 100 * MB });
    expect(p.singleShot).toBe(true);
  });

  it("clamps chunkBytes to safe range", () => {
    const p = planDropboxUpload(200 * MB, { chunkBytes: 100 * 1024 * 1024 * 1024 });
    // Max chunk = 60 MB → at least 4 chunks for 200 MB
    expect(p.chunks.length).toBeGreaterThanOrEqual(4);
  });
});
