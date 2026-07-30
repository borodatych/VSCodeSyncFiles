/**
 * Fast pre-commit guard against invisible characters in source.
 *
 * `tests/unit/sourceHygiene.test.ts` covers the whole tree, but it only runs in
 * `npm run verify`. The pre-commit hook runs eslint alone, and eslint says
 * nothing about a raw NUL — which is how one slipped into a commit even after
 * the gate existed. This script takes the staged files and checks just those,
 * so the hook stays fast.
 *
 * Usage: node scripts/check-source-hygiene.mjs <file...>
 */
import { readFileSync } from "node:fs";

const TAB = 9;
const LF = 10;
const CR = 13;
const FIRST_PRINTABLE = 32;
const PRIVATE_USE_START = 0xe000;
const PRIVATE_USE_END = 0xf8ff;

/** The file that documents these characters is allowed to name them. */
const ALLOWED = [/tests[\\/]unit[\\/]sourceHygiene\.test\.ts$/, /check-source-hygiene\.mjs$/];

function describe(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === TAB || code === LF || code === CR) continue;
    if (code < FIRST_PRINTABLE || (code >= PRIVATE_USE_START && code <= PRIVATE_USE_END)) {
      const line = text.slice(0, i).split("\n").length;
      const hex = code.toString(16).toUpperCase().padStart(4, "0");
      return { line, hex };
    }
  }
  return undefined;
}

const files = process.argv.slice(2);
const offenders = [];
for (const file of files) {
  if (ALLOWED.some((re) => re.test(file))) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const hit = describe(text);
  if (hit) offenders.push({ file, ...hit });
}

if (offenders.length > 0) {
  console.error("Сырые невидимые символы в исходниках (пишите escape-запись):");
  for (const o of offenders) {
    console.error(`  ${o.file}:${String(o.line)} — U+${o.hex}`);
  }
  console.error(
    "\nТакой байт делает файл бинарным для git и невидимым для grep. " +
      "Замените на \\uXXXX — значение строки не изменится.",
  );
  process.exit(1);
}
