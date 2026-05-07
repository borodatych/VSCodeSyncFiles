#!/usr/bin/env node
// Extract every `vscodesync.X` configuration property `description` from
// package.json into `cfg.X.description` placeholders.
// Walks `contributes.configuration.properties`. Idempotent.
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

function keyForProperty(propId) {
  // vscodesync.foo.bar → cfg.foo.bar.description
  return `cfg.${propId.replace(/^vscodesync\./, "")}.description`;
}

const props = pkg.contributes?.configuration?.properties ?? {};
for (const [propId, schema] of Object.entries(props)) {
  if (!propId.startsWith("vscodesync.")) continue;
  const desc = schema.description;
  if (typeof desc !== "string") continue;
  if (desc.startsWith("%") && desc.endsWith("%")) continue;

  const key = keyForProperty(propId);
  if (ru[key] !== desc) {
    ru[key] = desc;
    changed++;
  }
  if (en[key] === undefined) {
    // Fallback: keep Russian text. Translators will iterate over
    // package.nls.json in a follow-up.
    en[key] = desc;
    changed++;
  }
  schema.description = `%${key}%`;
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
writeFileSync(enPath, JSON.stringify(en, null, 2) + "\n", "utf8");
writeFileSync(ruPath, JSON.stringify(ru, null, 2) + "\n", "utf8");

console.log(`[i18n-extract-config-descriptions] updated ${changed} keys`);
