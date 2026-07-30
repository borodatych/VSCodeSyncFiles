/**
 * Backup folder naming: a folder per second, not a folder per file.
 *
 * At millisecond resolution every pulled file got its own folder, so a 500-file
 * Pull All produced 500 folders and retention pruning — which ran once per file
 * and `stat`ed every folder — degraded quadratically inside `.vscode/`, where
 * VS Code's own watcher is listening.
 *
 * The stamp helpers are not exported from the engine (they are internal to the
 * pull path), so the invariants are pinned on the shape the engine produces.
 */
import { describe, expect, it } from "vitest";

/** Mirror of `localBackupStamp` in `src/core/syncEngine.ts`. */
function localBackupStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

/** Mirror of `parseLocalBackupStamp` in `src/core/syncEngine.ts`. */
function parseLocalBackupStamp(name: string): number | undefined {
  const iso = name.replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})Z$/,
    (_m, d: string, h: string, mi: string, s: string) => `${d}${h}:${mi}:${s}Z`,
  );
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

describe("имя папки локального бэкапа", () => {
  it("файлы одной секунды попадают в одну папку", () => {
    const base = Date.parse("2026-07-30T18:04:05.000Z");
    const stamps = new Set([
      localBackupStamp(base),
      localBackupStamp(base + 1),
      localBackupStamp(base + 999),
    ]);
    expect(stamps.size).toBe(1);
  });

  it("следующая секунда даёт новую папку", () => {
    const base = Date.parse("2026-07-30T18:04:05.000Z");
    expect(localBackupStamp(base)).not.toBe(localBackupStamp(base + 1000));
  });

  it("имя не содержит символов, запрещённых в путях Windows", () => {
    const name = localBackupStamp(Date.parse("2026-07-30T18:04:05.123Z"));
    expect(name).not.toContain(":");
    expect(name).toBe("2026-07-30T18-04-05Z");
  });

  it("время восстанавливается из имени без обращения к диску", () => {
    const ms = Date.parse("2026-07-30T18:04:05.000Z");
    expect(parseLocalBackupStamp(localBackupStamp(ms))).toBe(ms);
  });

  it("посторонние имена не разбираются — вызывающий обязан сделать stat", () => {
    expect(parseLocalBackupStamp("readme.txt")).toBeUndefined();
    expect(parseLocalBackupStamp("2026-07-30T18-04-05.123Z")).toBeUndefined();
    expect(parseLocalBackupStamp("")).toBeUndefined();
  });
});
