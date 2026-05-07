/**
 * Ensures the browser bundle does not pull Node-only builtins (web extension constraint).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "dist", "extension.web.js");
let body;
try {
  body = readFileSync(path, "utf8");
} catch {
  console.error("[verify-web-bundle] missing", path);
  process.exit(1);
}

const forbidden = [
  { needle: "node:", hint: "Node builtin scheme must not appear in web bundle" },
  { needle: 'require("fs")', hint: "fs must not be required in web bundle" },
  { needle: "require('fs')", hint: "fs must not be required in web bundle" },
  { needle: 'require("node:fs")', hint: "" },
];

for (const { needle, hint } of forbidden) {
  if (body.includes(needle)) {
    console.error(`[verify-web-bundle] forbidden substring ${JSON.stringify(needle)}. ${hint}`);
    process.exit(1);
  }
}

console.log("[verify-web-bundle] OK");
