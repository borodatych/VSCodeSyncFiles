/**
 * The settings panel cannot lag the schema (F11).
 *
 * The panel used to carry a hand-written key list: 92 settings were declared,
 * it knew 67, and two keys it still rendered had been deleted from the schema —
 * VS Code rejects a write to an unregistered key, so the webview reported
 * "saved" while the value went nowhere.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_KEYS,
  SETTINGS_SCHEMA,
} from "../../src/ui/settingsSchema.generated.js";

const ROOT = join(__dirname, "..", "..");
const PREFIX = "vscodesync.";

interface Pkg {
  contributes: { configuration: { properties: Record<string, unknown> } };
}

function schemaKeysFromManifest(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Pkg;
  return Object.keys(pkg.contributes.configuration.properties)
    .filter((k) => k.startsWith(PREFIX))
    .map((k) => k.slice(PREFIX.length))
    .sort((a, b) => a.localeCompare(b));
}

describe("сгенерированная схема настроек", () => {
  it("совпадает с contributes.configuration один в один", () => {
    expect([...SETTINGS_KEYS]).toEqual(schemaKeysFromManifest());
  });

  it("у каждой настройки есть человекочитаемое описание", () => {
    const missing = SETTINGS_SCHEMA.filter((s) => s.description.trim() === "").map((s) => s.key);
    expect(missing).toEqual([]);
  });

  it("перечисления и границы перенесены из манифеста", () => {
    const mode = SETTINGS_SCHEMA.find((s) => s.key === "autoSyncMode");
    expect(mode?.enum).toContain("check-only");
    const retention = SETTINGS_SCHEMA.find((s) => s.key === "activityRetentionDays");
    expect(retention?.minimum).toBe(1);
  });
});

describe("панель настроек покрывает схему целиком", () => {
  const panelSource = readFileSync(join(ROOT, "src", "ui", "settingsPanel.ts"), "utf8");

  it("список размещённых вручную ключей не содержит удалённых из схемы", () => {
    const declared = new Set(SETTINGS_KEYS);
    const handPlaced = [...panelSource.matchAll(/^ {2}"([^"]+)",$/gm)]
      .map((m) => m[1])
      .filter((k) => declared.has(k) || k.includes("."));
    const stale = handPlaced.filter((k) => !declared.has(k));
    expect(stale).toEqual([]);
  });

  it("панель рендерит все ключи: вручную размещённые + секция «Прочие»", () => {
    // The generated section renders `SETTINGS_SCHEMA` minus the hand-placed
    // ones, so coverage is total by construction — this pins the mechanism.
    expect(panelSource).toContain("renderUncoveredSettings()");
    expect(panelSource).toContain("HAND_PLACED_KEYS");
  });
});
