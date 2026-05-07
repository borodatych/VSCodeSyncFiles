import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadStatsFile,
  recordCompressionSaving,
  recordTransferBytes,
  rolloverTrafficIfNeeded,
  statsFilePath,
  trafficMonthKeyLocal,
  type StatsFileV1,
} from "../../src/core/syncStatsStore.js";

describe("syncStatsStore", () => {
  it("rollover clears bytes when month key changes", () => {
    const prev: StatsFileV1 = {
      schema: 1,
      trafficMonthKey: "2020-01",
      bytesUploadedMonth: 999,
      bytesDownloadedMonth: 888,
      bytesSavedByCompressionMonth: 10,
    };
    const next = rolloverTrafficIfNeeded(prev);
    expect(next.trafficMonthKey).toBe(trafficMonthKeyLocal());
    expect(next.bytesUploadedMonth).toBe(0);
    expect(next.bytesDownloadedMonth).toBe(0);
    expect(next.bytesSavedByCompressionMonth).toBe(0);
  });

  it("recordTransferBytes accumulates upload", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-stat-"));
    try {
      await recordTransferBytes(dir, { direction: "upload", bytes: 1000 });
      await recordTransferBytes(dir, { direction: "download", bytes: 400 });
      const s = await loadStatsFile(dir);
      expect(s.bytesUploadedMonth).toBe(1000);
      expect(s.bytesDownloadedMonth).toBe(400);
      const raw = await fs.readFile(statsFilePath(dir), "utf8");
      expect(raw).toContain('"schema": 1');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("recordCompressionSaving increments compression counter", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-stat-"));
    try {
      await recordCompressionSaving(dir, 500);
      await recordCompressionSaving(dir, 100);
      const s = await loadStatsFile(dir);
      expect(s.bytesSavedByCompressionMonth).toBe(600);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
