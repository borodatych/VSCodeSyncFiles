/**
 * Regression guard for the size of `src/extension.ts` (v2.11.4).
 *
 * Phase 0 brought the file from 1734 LoC down to ~806 LoC by extracting
 * 8 startup modules. The long-term target is `< 500 LoC` (just `activate()`
 * orchestration); the current ceiling reflects the remaining helpers
 * (engine drivers, planned palette, scheduling monitors, snapshots) that
 * still live inline.
 *
 * This test fails when extension.ts grows past `LOC_CEILING`, so any future
 * commit either tightens the budget or extracts another startup module.
 * Bumping the ceiling without an extraction PR is a code smell.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_TS = resolve(HERE, "..", "..", "src", "extension.ts");

/** Hard ceiling — see header for the rationale. Lower this whenever a new
 * extraction lands; never raise it without a follow-up extraction issue. */
const LOC_CEILING = 570;

/** Soft target — when current LoC drops below this, lower the ceiling. */
const LOC_SOFT_TARGET = 500;

describe("src/extension.ts size guard", () => {
  it("stays below the regression ceiling", () => {
    const lines = readFileSync(EXTENSION_TS, "utf8").split(/\r?\n/).length;
    expect(lines).toBeLessThanOrEqual(LOC_CEILING);
  });

  it("flags when the soft target is met (informational)", () => {
    const lines = readFileSync(EXTENSION_TS, "utf8").split(/\r?\n/).length;
    if (lines <= LOC_SOFT_TARGET) {
       
      console.log(
        `extension.ts is at ${String(lines)} LoC — at or below soft target ${String(LOC_SOFT_TARGET)}. ` +
        `Consider lowering LOC_CEILING in tests/unit/extensionTsLoc.test.ts.`,
      );
    }
    expect(lines).toBeGreaterThan(0);
  });
});
