/**
 * Link Bindings gate: manifest/_meta/blob/history keying must go through
 * `manifestKeyOf` (docs/v2/linkBindings.md).
 *
 * `TrackedFile.localPath` is this machine's placement; the cloud speaks the
 * canonical `manifestPath ?? localPath`. Keying cloud state by `localPath`
 * compiles, passes on unbound files, and silently forks the manifest row,
 * `_meta` row and blob the first time a user binds a file — a data-corruption
 * class, not a style issue. Same shape as `trackedPathResolverUsage` (C13):
 * a fresh bypass fails the gate by name.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** Each pattern is a way to key cloud state by the machine-local path. */
const BYPASSES: readonly { name: string; re: RegExp }[] = [
  { name: "meta.files[<x>.localPath]", re: /\.files\[[A-Za-z0-9_.]*\.localPath\]/ },
  { name: "manifest row match by localPath", re: /\.path === [A-Za-z0-9_.]*\.localPath/ },
  { name: "blobCloudPath(.., <x>.localPath, ..)", re: /blobCloudPath\([^)]*\.localPath/ },
  { name: "trackedFileCloudPath(.., <x>.localPath)", re: /trackedFileCloudPath\([^)]*\.localPath/ },
  { name: "historyDirForFile(.., <x>.localPath)", re: /historyDirForFile\([^)]*\.localPath/ },
];

/**
 * Sites where `.localPath` inside the matched expression is correct — each
 * entry names why. Additions require the same justification.
 */
const ALLOWED = new Set<string>([
  // planWorkspaceMergeCfg passes manifestKeyOf(f) — the regexes don't match it.
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

describe("Link Bindings — ключевание облака только через manifestKeyOf", () => {
  it("ни один модуль не ключует манифест/_meta/blob/history по localPath", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(ROOT, file).replaceAll("\\", "/");
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const { name, re } of BYPASSES) {
        if (re.test(text)) {
          offenders.push(`${rel}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("гейт не пуст сам по себе: manifestKeyOf реально используется в движке", () => {
    const engine = readFileSync(join(SRC, "core", "syncEngine.ts"), "utf8");
    expect(engine.includes("manifestKeyOf(")).toBe(true);
  });
});
