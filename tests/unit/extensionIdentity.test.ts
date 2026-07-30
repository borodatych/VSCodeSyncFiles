/**
 * Pins `src/core/extensionIdentity.ts` to package.json.
 *
 * Three call sites used to open the Settings UI with the stale filter
 * `@ext:vscodesync.vscodesync`, which matches nothing, and the integration
 * suite looked the extension up under the same dead id. Neither failure is
 * visible at compile time, so the id is asserted here instead.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_SECTION,
  EXTENSION_ID,
  EXTENSION_SETTINGS_QUERY,
} from "../../src/core/extensionIdentity.js";

interface PackageJson {
  publisher?: string;
  name?: string;
  contributes?: { configuration?: { properties?: Record<string, unknown> } };
}

function readPackageJson(): PackageJson {
  const root = join(__dirname, "..", "..");
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
}

describe("extensionIdentity ↔ package.json", () => {
  it("EXTENSION_ID equals publisher.name", () => {
    const pkg = readPackageJson();
    expect(EXTENSION_ID).toBe(`${String(pkg.publisher)}.${String(pkg.name)}`);
  });

  it("EXTENSION_SETTINGS_QUERY is derived from EXTENSION_ID", () => {
    expect(EXTENSION_SETTINGS_QUERY).toBe(`@ext:${EXTENSION_ID}`);
  });

  it("CONFIG_SECTION prefixes every contributed setting", () => {
    const pkg = readPackageJson();
    const keys = Object.keys(pkg.contributes?.configuration?.properties ?? {});
    expect(keys.length).toBeGreaterThan(0);
    const foreign = keys.filter((k) => !k.startsWith(`${CONFIG_SECTION}.`));
    expect(foreign).toEqual([]);
  });
});

describe("no source file hardcodes a stale extension id", () => {
  it("the dead id vscodesync.vscodesync appears nowhere in src/", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const root = join(__dirname, "..", "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        // The identity module itself names the dead id in its doc comment to
        // explain why the constant exists — that mention is the point.
        if (entry === "extensionIdentity.ts") continue;
        if (readFileSync(full, "utf8").includes("vscodesync.vscodesync")) {
          offenders.push(full);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
