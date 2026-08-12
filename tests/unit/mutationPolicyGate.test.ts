/**
 * Coverage gate for the mutation checkpoint (finding F2).
 *
 * `MUTATION_OPS` claims to be the single source of truth for what the engine
 * gates, and 37 `assertMayMutate` calls were placed by hand to honour that
 * claim. Nothing in the type system connects the two: a new mutating method,
 * or a call deleted during a refactor, would leave the union saying one thing
 * and the code doing another — and the symptom (a background source quietly
 * writing again) is invisible until a user reports it.
 *
 * So the gate reads the engine source and checks the correspondence, in the
 * shape the project already uses for `settingsSchemaConsistency` and
 * `trackedPathResolverUsage`: known debt is listed by name, and anything new
 * fails.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { MUTATION_OPS } from "../../src/core/syncPolicy.js";

const ROOT = join(__dirname, "..", "..");
const ENGINE = join(ROOT, "src", "core", "syncEngine.ts");

/**
 * Source with comments blanked out, line count preserved.
 *
 * Every rule below is about code. Without this the gate fires on its own
 * documentation: the header of `syncPolicy.ts` names the three `bypass*`
 * parameters it removed, which is precisely the record we want to keep.
 */
function readSource(abs: string): string {
  return readFileSync(abs, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Gated operations whose checkpoint is legitimately conditional. Empty since
 * B5/B6: `checkWorkspaceStatus` got its own body, so `syncWorkspace` no longer
 * needs a `checkOnly` escape. Kept as a named list (not deleted) so the next
 * genuine exception has to be declared here with its reason, visibly.
 */
const CONDITIONAL_GATES: Record<string, string> = {};

describe("MUTATION_OPS ↔ syncEngine.ts", () => {
  const engine = readSource(ENGINE);

  it("каждая операция из MUTATION_OPS вызывает assertMayMutate в движке", () => {
    const missing = MUTATION_OPS.filter((op) => !engine.includes(`this.assertMayMutate("${op}")`));
    expect(missing).toEqual([]);
  });

  it("каждый вызов assertMayMutate ссылается на операцию из MUTATION_OPS", () => {
    const re = /this\.assertMayMutate\("([A-Za-z0-9_]+)"\)/g;
    const called = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(engine)) !== null) called.add(m[1]);
    const unknown = [...called].filter((op) => !(MUTATION_OPS as readonly string[]).includes(op));
    expect(unknown).toEqual([]);
  });

  it("гейт стоит первой инструкцией метода, кроме названных исключений", () => {
    const lines = engine.split("\n");
    const notFirst: string[] = [];
    for (const op of MUTATION_OPS) {
      if (op in CONDITIONAL_GATES) continue;
      const ix = lines.findIndex((l) => l.includes(`this.assertMayMutate("${op}")`));
      if (ix < 1) continue;
      // The line above must be the method's body opener, i.e. end in `{`.
      if (!lines[ix - 1].trimEnd().endsWith("{")) {
        notFirst.push(`${op} → строка ${String(ix + 1)} не первая в теле метода`);
      }
    }
    expect(notFirst).toEqual([]);
  });

  it("условный гейт есть только у операций из CONDITIONAL_GATES", () => {
    const lines = engine.split("\n");
    const conditional: string[] = [];
    for (const op of MUTATION_OPS) {
      const ix = lines.findIndex((l) => l.includes(`this.assertMayMutate("${op}")`));
      if (ix < 1) continue;
      const prev = lines[ix - 1].trim();
      if (prev.startsWith("if (") && !(op in CONDITIONAL_GATES)) {
        conditional.push(`${op} → гейт под условием, но не объявлен в CONDITIONAL_GATES`);
      }
    }
    expect(conditional).toEqual([]);
  });

  it("CONDITIONAL_GATES не содержит операций, у которых гейт уже безусловный", () => {
    const lines = engine.split("\n");
    const stale = Object.keys(CONDITIONAL_GATES).filter((op) => {
      const ix = lines.findIndex((l) => l.includes(`this.assertMayMutate("${op}")`));
      return ix > 0 && !lines[ix - 1].trim().startsWith("if (");
    });
    expect(stale).toEqual([]);
  });
});

describe("нет обходных путей мимо политики", () => {
  const srcFiles = sourceFiles(join(ROOT, "src"));

  it("параметры bypass* не вернулись", () => {
    const offenders = srcFiles
      .filter((f) => /\bbypass[A-Z]/.test(readSource(f)))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("каждый вызов makeEngine передаёт триггер явно", () => {
    const bad: string[] = [];
    for (const file of srcFiles) {
      const rel = relative(ROOT, file);
      if (rel.endsWith("_engineFactory.ts")) continue;
      readSource(file)
        .split("\n")
        .forEach((line, i) => {
          if (!/\bmakeEngine\s*\(/.test(line)) return;
          // Declarations and forwarded parameters are not call sites.
          if (/makeEngine\s*\(\s*$/.test(line.trim())) return;
          // Either a literal, or the caller's own declared trigger forwarded on.
          if (/"(user|auto)"\s*\)/.test(line) || /,\s*(?:[A-Za-z_][\w.]*\.)?trigger\s*\)/.test(line)) return;
          bad.push(`${rel}:${String(i + 1)}`);
        });
    }
    expect(bad).toEqual([]);
  });

  it("решение о триггере принимается только в syncPolicy.ts (внутри src/core)", () => {
    const bad: string[] = [];
    for (const file of sourceFiles(join(ROOT, "src", "core"))) {
      const rel = relative(ROOT, file);
      if (rel.endsWith("syncPolicy.ts")) continue;
      readSource(file)
        .split("\n")
        .forEach((line, i) => {
          if (/trigger\s*[=!]==\s*"/.test(line)) bad.push(`${rel}:${String(i + 1)}`);
        });
    }
    expect(bad).toEqual([]);
  });
});

/**
 * `runWithEngine` builds a `"user"` engine when the caller says nothing, which
 * is right for the palette commands it exists to serve and wrong for anything
 * else. The rule is therefore about *who* is allowed to stay silent.
 */
const COMMAND_MODULES = [
  "src/commands/_engineFlows.ts",
  "src/commands/_placementFlow.ts",
  "src/commands/registerConflicts.ts",
  "src/commands/registerFileOperations.ts",
  "src/commands/registerFileTreeContext.ts",
  "src/commands/registerFolderActions.ts",
  "src/commands/registerHeavyMisc.ts",
  "src/commands/registerLinkBindings.ts",
  "src/commands/registerPhase21Commands.ts",
  "src/commands/registerSyncOps.ts",
  "src/commands/registerWorkspaceCreate.ts",
  "src/commands/registerWorkspaceLifecycle.ts",
  "src/commands/registerWorkspaceMgmt.ts",
  "src/commands/registerWorkspaceTreeContext.ts",
];

describe("runWithEngine: умолчание «user» доступно только командам", () => {
  it("не-командные модули указывают триггер на каждом вызове", () => {
    const bad: string[] = [];
    for (const file of sourceFiles(join(ROOT, "src"))) {
      const rel = relative(ROOT, file).split("\\").join("/");
      if (COMMAND_MODULES.includes(rel)) continue;
      const text = readSource(file);
      const calls = (text.match(/\brunWithEngine\s*\(\s*(async|\()/g) ?? []).length;
      if (calls === 0) continue;
      const explicit = (text.match(/trigger:\s*"(user|auto)"/g) ?? []).length;
      if (explicit < calls) {
        bad.push(`${rel}: вызовов ${String(calls)}, явных триггеров ${String(explicit)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("COMMAND_MODULES не содержит модулей, которые больше не зовут runWithEngine", () => {
    const stale = COMMAND_MODULES.filter(
      (rel) => !/\brunWithEngine\s*\(\s*(async|\()/.test(readSource(join(ROOT, rel))),
    );
    expect(stale).toEqual([]);
  });
});
