/**
 * Guards against invisible characters written as raw bytes in source.
 *
 * Four files used a raw NUL as a key separator. Git classifies any file holding
 * a NUL as binary, so `grep` skipped them silently — the whole 4157-line
 * `syncEngine.ts` was invisible to search, and `text=auto` refused to normalise
 * its line endings. Two more files used a raw U+0001 sentinel and one a raw
 * U+E000; those do not break git, but they are unreadable in an editor and
 * impossible to grep for. Escape sequences are semantically identical, so there
 * is no reason to ever write the byte itself.
 *
 * The predicates below are written with char codes rather than regex literals
 * on purpose: a literal would put the very bytes this file forbids into this
 * file, and the check would fail on itself.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SCANNED_DIRS = ["src", "tests", "cli/src", "scripts"];

const TAB = 9;
const LF = 10;
const CR = 13;
const FIRST_PRINTABLE = 32;
const PRIVATE_USE_START = 0xe000;
const PRIVATE_USE_END = 0xf8ff;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|mjs|cjs|js)$/.test(entry)) out.push(full);
    }
  };
  for (const d of SCANNED_DIRS) walk(join(ROOT, d));
  return out;
}

/** Any control character other than tab, LF and CR. NUL included. */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === TAB || code === LF || code === CR) continue;
    if (code < FIRST_PRINTABLE) return true;
  }
  return false;
}

/** Unicode private-use area — renders as nothing in every editor. */
function hasPrivateUseChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= PRIVATE_USE_START && code <= PRIVATE_USE_END) return true;
  }
  return false;
}

function hasCrlf(text: string): boolean {
  for (let i = 1; i < text.length; i += 1) {
    if (text.charCodeAt(i) === LF && text.charCodeAt(i - 1) === CR) return true;
  }
  return false;
}

describe("гигиена исходников: никаких сырых невидимых байтов", () => {
  const files = sourceFiles();
  const relative = (f: string): string => f.slice(ROOT.length + 1);

  it("сканирование действительно находит исходники", () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it("ни один файл не содержит управляющих символов", () => {
    const offenders = files.filter((f) => hasControlChar(readFileSync(f, "utf8"))).map(relative);
    expect(offenders).toEqual([]);
  });

  it("ни один файл не содержит символов приватной зоны Unicode", () => {
    const offenders = files.filter((f) => hasPrivateUseChar(readFileSync(f, "utf8"))).map(relative);
    expect(offenders).toEqual([]);
  });

  it("ни один файл не содержит CRLF — нормализация задана в .gitattributes", () => {
    const offenders = files.filter((f) => hasCrlf(readFileSync(f, "utf8"))).map(relative);
    expect(offenders).toEqual([]);
  });
});
