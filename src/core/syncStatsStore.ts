import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeTextFileAtomic } from "./writeTextFileAtomic.js";

const STATS_FILE = "stats.json";

export interface SyncTransferEvent {
  direction: "upload" | "download";
  bytes: number;
}

export interface StatsFileV1 {
  schema: 1;
  /** YYYY-MM in local time — обновляется при смене месяца. */
  trafficMonthKey: string;
  bytesUploadedMonth: number;
  bytesDownloadedMonth: number;
  /** Накопленная оценка экономии при сжатии (когда движок шлёт delta). */
  bytesSavedByCompressionMonth: number;
}

export function statsFilePath(storageDir: string): string {
  return path.join(storageDir, STATS_FILE);
}

export function trafficMonthKeyLocal(d: Date = new Date()): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function rolloverTrafficIfNeeded(s: StatsFileV1): StatsFileV1 {
  const cur = trafficMonthKeyLocal();
  if (s.trafficMonthKey === cur) {
    return s;
  }
  return {
    schema: 1,
    trafficMonthKey: cur,
    bytesUploadedMonth: 0,
    bytesDownloadedMonth: 0,
    bytesSavedByCompressionMonth: 0,
  };
}

export async function loadStatsFile(storageDir: string): Promise<StatsFileV1> {
  const fp = statsFilePath(storageDir);
  try {
    const raw = await fs.readFile(fp, "utf8");
    const data = JSON.parse(raw) as Partial<StatsFileV1>;
    const parsed: StatsFileV1 = {
      schema: 1,
      trafficMonthKey: typeof data.trafficMonthKey === "string" ? data.trafficMonthKey : trafficMonthKeyLocal(),
      bytesUploadedMonth: typeof data.bytesUploadedMonth === "number" ? data.bytesUploadedMonth : 0,
      bytesDownloadedMonth: typeof data.bytesDownloadedMonth === "number" ? data.bytesDownloadedMonth : 0,
      bytesSavedByCompressionMonth:
        typeof data.bytesSavedByCompressionMonth === "number" ? data.bytesSavedByCompressionMonth : 0,
    };
    const rolled = rolloverTrafficIfNeeded(parsed);
    if (rolled.trafficMonthKey !== parsed.trafficMonthKey) {
      await saveStatsFile(storageDir, rolled);
    }
    return rolled;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        schema: 1,
        trafficMonthKey: trafficMonthKeyLocal(),
        bytesUploadedMonth: 0,
        bytesDownloadedMonth: 0,
        bytesSavedByCompressionMonth: 0,
      };
    }
    throw e;
  }
}

export async function saveStatsFile(storageDir: string, s: StatsFileV1): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });
  const fp = statsFilePath(storageDir);
  await writeTextFileAtomic(fp, `${JSON.stringify(s, null, 2)}\n`);
}

/** Increments `bytesSavedByCompressionMonth` — gzip savings vs uncompressed plaintext upload size (same month bucket). */
export async function recordCompressionSaving(storageDir: string, plaintextBytesSaved: number): Promise<void> {
  if (!Number.isFinite(plaintextBytesSaved) || plaintextBytesSaved <= 0) {
    return;
  }
  let s = await loadStatsFile(storageDir);
  s = rolloverTrafficIfNeeded(s);
  s.bytesSavedByCompressionMonth += Math.floor(plaintextBytesSaved);
  await saveStatsFile(storageDir, s);
}

export async function recordTransferBytes(storageDir: string, ev: SyncTransferEvent): Promise<void> {
  let s = await loadStatsFile(storageDir);
  s = rolloverTrafficIfNeeded(s);
  if (ev.direction === "upload") {
    s.bytesUploadedMonth += ev.bytes;
  } else {
    s.bytesDownloadedMonth += ev.bytes;
  }
  await saveStatsFile(storageDir, s);
}
