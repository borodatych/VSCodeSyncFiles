/**
 * Absolute <-> tracked-posix conversions must go through `trackedPathResolver`.
 *
 * `pathMapping` lets a machine keep synced files in a subdirectory of the
 * workspace folder. Hand-rolled `path.join(root, ...rel.split("/"))` and
 * `path.relative(root, abs)` ignore it, so with a mapping configured those call
 * sites compute a path that does not exist: a file that *is* tracked reads as
 * "not in sync", its decoration vanishes and commands over it do nothing.
 *
 * Sites still to convert are listed by name rather than skipped, the same way
 * `settingsSchemaConsistency` handles unwired settings: the debt stays visible
 * and a newly added bypass fails the gate.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** `path.join(<root-ish>, ...<rel>.split("/"))` — the forward bypass. */
const JOIN_BYPASS = /path\.join\([^)]*,\s*\.\.\.[A-Za-z0-9_.]*\.split\("\/"\)\)/;
/** `path.relative(<root-ish>, <abs>).split(path.sep).join("/")` — the reverse bypass. */
const RELATIVE_BYPASS = /path\.relative\([^)]*\)\s*\.split\(path\.sep\)\s*\.join\("\/"\)/;

/**
 * Files still doing the conversion by hand. Each entry is a real defect under a
 * non-empty `pathMapping`; they are being converted in batches.
 */
const NOT_YET_CONVERTED = new Set([
  // Engine-internal: already uses the resolver for tracked files; these joins
  // build backup and history paths, which are not tracked-file conversions.
  "commands/_engineFlows.ts",
  // Git paths are relative to the *repo* root, not to the sync root.
  "ui/syncTriggerManager.ts",
  // Conversion pending — see `.cursor/plans/stabilization100.plan.md`, C13.
  "ui/syncOfflineFlush.ts",
  "ui/syncScheduleDeferredFlush.ts",
  "ui/vscodeSyncUriHandler.ts",
  "ui/workspacesTree.ts",
  "ui/quickTransferDropPanel.ts",
  "ui/quickTransferUi.ts",
  "commands/registerConflicts.ts",
  "commands/registerEncryptedBundleExport.ts",
  "commands/registerFileOperations.ts",
  "commands/registerWorkspaceLifecycle.ts",
  "commands/registerPhase21Commands.ts",
  "startup/registerWorkspaceTreeWiring.ts",
  "startup/registerFileLifecycleEvents.ts",
  // Ignore-rule matching works on paths relative to the *workspace folder*,
  // which is what `.syncignore` semantics are defined against — not a bypass.
  "core/workspaceIgnoreRules.ts",
]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

function relative(file: string): string {
  return file.slice(SRC.length + 1).replace(/\\/g, "/");
}

describe("резолвер tracked-пути: обходы не добавляются", () => {
  const files = sourceFiles();

  it("сканирование находит исходники", () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it("никаких новых ручных преобразований пути", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(file);
      // The engine owns the low-level helpers and is their legitimate caller.
      if (rel === "core/pathMapping.ts" || rel === "core/trackedPathResolver.ts") continue;
      if (rel === "core/syncEngine.ts") continue;
      if (NOT_YET_CONVERTED.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      if (JOIN_BYPASS.test(text) || RELATIVE_BYPASS.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("список непереведённых не содержит уже переведённых файлов", () => {
    const stale: string[] = [];
    for (const rel of NOT_YET_CONVERTED) {
      const full = join(SRC, rel);
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        stale.push(`${rel} (файла нет)`);
        continue;
      }
      if (!JOIN_BYPASS.test(text) && !RELATIVE_BYPASS.test(text)) stale.push(rel);
    }
    expect(stale).toEqual([]);
  });
});
