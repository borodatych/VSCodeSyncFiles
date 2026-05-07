#!/usr/bin/env node
// Extract every command title from package.json into package.nls.json /
// package.nls.ru.json placeholders. Idempotent: titles that are already
// %placeholders% are left alone.
//
// Run: `node scripts/i18n-extract-titles.mjs`
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

const pkgPath = join(root, "package.json");
const enPath = join(root, "package.nls.json");
const ruPath = join(root, "package.nls.ru.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const en = JSON.parse(readFileSync(enPath, "utf8"));
const ru = JSON.parse(readFileSync(ruPath, "utf8"));

let changed = 0;

function keyForCommand(commandId) {
  // vscodesync.fooBar → cmd.fooBar.title
  const tail = commandId.replace(/^vscodesync\./, "");
  return `cmd.${tail}.title`;
}

// Trivial English mirror: drop the prefix, keep the rest of the Russian text.
// For commands where we don't know the English wording, fall back to the
// Russian title — translators can iterate later.
function fallbackEn(ruTitle) {
  return ruTitle;
}

for (const cmd of pkg.contributes?.commands ?? []) {
  const id = cmd.command;
  if (!id) continue;
  const title = cmd.title;
  if (typeof title !== "string") continue;
  if (title.startsWith("%") && title.endsWith("%")) continue; // already i18n'd

  const key = keyForCommand(id);
  // Always set Russian to the original title.
  if (ru[key] !== title) {
    ru[key] = title;
    changed++;
  }
  // Only set English if not already translated.
  if (en[key] === undefined) {
    en[key] = fallbackEn(title);
    changed++;
  }
  cmd.title = `%${key}%`;
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
writeFileSync(enPath, JSON.stringify(en, null, 2) + "\n", "utf8");
writeFileSync(ruPath, JSON.stringify(ru, null, 2) + "\n", "utf8");

console.log(`[i18n-extract-titles] updated ${changed} keys`);
