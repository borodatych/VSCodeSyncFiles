/**
 * v2.6.7 — CI guard for the extension.ts decomposition.
 *
 * Asserts that every command id declared in package.json contributes.commands
 * is present in the generated WEB_STUB_COMMAND_IDS list. If a refactor moves
 * a command into a different file but accidentally drops it from package.json
 * (or vice versa), this test fails.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEB_STUB_COMMAND_IDS } from "../../src/webStubCommands.generated.js";

interface PackageContributesCommand {
  command?: unknown;
}
interface PackageJson {
  contributes?: { commands?: PackageContributesCommand[] };
}

describe("package.json contributes.commands ↔ WEB_STUB_COMMAND_IDS", () => {
  it("every contributed command is present in WEB_STUB_COMMAND_IDS", () => {
    const root = join(__dirname, "..", "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
    const declared: string[] = (pkg.contributes?.commands ?? [])
      .map((c) => c.command)
      .filter((x): x is string => typeof x === "string" && x.length > 0);

    const stubSet = new Set(WEB_STUB_COMMAND_IDS);
    const missing = declared.filter((id) => !stubSet.has(id));
    expect(missing).toEqual([]);
  });

  it("WEB_STUB_COMMAND_IDS contains no duplicates", () => {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const id of WEB_STUB_COMMAND_IDS) {
      if (seen.has(id)) dups.push(id);
      seen.add(id);
    }
    expect(dups).toEqual([]);
  });
});
