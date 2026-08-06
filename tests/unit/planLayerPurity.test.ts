/**
 * `src/core/plan/` stays pure, and `syncEngine.ts` stops growing (этап 5.1).
 *
 * The point of the layer is that "what would the engine do here?" can be
 * answered by a test with no provider, no filesystem and no `vscode`. One
 * convenience import is all it takes to lose that, so the rule is a gate rather
 * than a convention.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const PLAN_DIR = join(ROOT, "src", "core", "plan");

/** Anything that drags in an environment: the editor API, I/O, or the UI layer. */
const FORBIDDEN = [
  /from\s+"vscode"/,
  /from\s+"node:fs(\/promises)?"/,
  /from\s+"node:http/,
  /from\s+"\.\.\/\.\.\/ui\//,
  /from\s+"\.\.\/\.\.\/providers\//,
];

function planFiles(): string[] {
  return readdirSync(PLAN_DIR).filter((f) => f.endsWith(".ts"));
}

describe("слой src/core/io не тянет UI и редактор", () => {
  const IO_DIR = join(ROOT, "src", "core", "io");
  const IO_FORBIDDEN = [/from\s+"vscode"/, /from\s+"\.\.\/\.\.\/ui\//];

  it("ни один io-модуль не импортирует vscode или ui/", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(IO_DIR).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(join(IO_DIR, f), "utf8");
      if (IO_FORBIDDEN.some((re) => re.test(text))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe("слой src/core/plan остаётся чистым", () => {
  it("каталог не пуст", () => {
    expect(planFiles().length).toBeGreaterThan(0);
  });

  it("ни один модуль не импортирует vscode, ФС, сеть или UI", () => {
    const offenders: string[] = [];
    for (const f of planFiles()) {
      const text = readFileSync(join(PLAN_DIR, f), "utf8");
      if (FORBIDDEN.some((re) => re.test(text))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The ceiling exists because the file already grew from 4157 to 4583 lines
 * between the refactor being planned and being started. Lowered as each stage
 * moves code out — never raised.
 */
const SYNC_ENGINE_LINE_CEILING = 4150;

describe("syncEngine.ts не разрастается", () => {
  it(`не длиннее ${String(SYNC_ENGINE_LINE_CEILING)} строк`, () => {
    const lines = readFileSync(join(ROOT, "src", "core", "syncEngine.ts"), "utf8").split("\n").length;
    expect(lines).toBeLessThanOrEqual(SYNC_ENGINE_LINE_CEILING);
  });
});
