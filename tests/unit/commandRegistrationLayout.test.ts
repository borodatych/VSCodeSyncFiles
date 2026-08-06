/**
 * Where a command is handled must be answerable by looking in one place (F12).
 *
 * Registration used to be spread over 129 sites in `src/commands` and 40 in
 * `src/ui`, 27 of them inside a single 1115-line module covering seven
 * unrelated domains. The eslint rule enforces the boundary; this test pins the
 * two things eslint cannot say — that the junk drawer is gone and that the
 * exemption list stays short and true.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const UI = join(ROOT, "src", "ui");
const PALETTE = join(ROOT, "src", "commands", "palette");

/** Panels/features that own the single command which opens them. */
const ALLOWED_UI_REGISTRARS = [
  "commandCenter.ts",
  "passkeyCommands.ts",
  "providerMigrationUi.ts",
  "providerSetupGuide.ts",
  "quickTransferUi.ts",
  "settingsPanel.ts",
  "trustedTeammatesUi.ts",
];

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name);
}

describe("регистрация команд живёт в src/commands", () => {
  it("junk drawer plannedPaletteCommands.ts удалён", () => {
    expect(existsSync(join(UI, "plannedPaletteCommands.ts"))).toBe(false);
  });

  it("в src/ui регистрируют команды только модули из списка исключений", () => {
    const offenders = tsFilesIn(UI).filter((name) => {
      if (ALLOWED_UI_REGISTRARS.includes(name)) return false;
      return readFileSync(join(UI, name), "utf8").includes("vscode.commands.registerCommand");
    });
    expect(offenders).toEqual([]);
  });

  it("список исключений не содержит файлов, которые уже ничего не регистрируют", () => {
    const stale = ALLOWED_UI_REGISTRARS.filter((name) => {
      const p = join(UI, name);
      if (!existsSync(p)) return true;
      return !readFileSync(p, "utf8").includes("vscode.commands.registerCommand");
    });
    expect(stale).toEqual([]);
  });

  it("палитра разрезана по доменам: семь групп плюс общий модуль и вход", () => {
    const files = tsFilesIn(PALETTE).sort();
    expect(files).toEqual([
      "_shared.ts",
      "encryptionKeyCommands.ts",
      "index.ts",
      "insightsPanelCommands.ts",
      "pauseAndWatch.ts",
      "snapshotCommands.ts",
      "syncDiagnosticsCommands.ts",
      "workspaceLayoutCommands.ts",
      "workspaceStructureCommands.ts",
    ]);
  });

  it("ни один доменный модуль палитры не разрастается заново", () => {
    const CEILING = 320;
    const tooBig = tsFilesIn(PALETTE)
      .map((name) => ({ name, lines: readFileSync(join(PALETTE, name), "utf8").split("\n").length }))
      .filter((f) => f.lines > CEILING);
    expect(tooBig).toEqual([]);
  });

  it("все 27 команд бывшего junk drawer зарегистрированы ровно один раз", () => {
    const registered = tsFilesIn(PALETTE)
      .flatMap((name) => [
        ...readFileSync(join(PALETTE, name), "utf8").matchAll(
          /registerCommand\("(vscodesync\.[^"]+)"/g,
        ),
      ])
      .map((m) => m[1]);
    expect(registered).toHaveLength(27);
    expect(new Set(registered).size).toBe(27);
  });
});
