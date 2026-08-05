/**
 * The decision half of the one-shot 1.0.0 migration (stage 3.4).
 *
 * The executor runs once per machine and cannot be replayed on a developer's
 * box, so everything worth arguing about — which scopes rewrite, which keys
 * clear, when the "mode changed" toast fires — is proven here, on snapshots.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REMOVED_SETTINGS_100,
  planSettingsMigration,
} from "../../src/core/settingsMigrationPlan.js";

describe("planSettingsMigration", () => {
  it("пустой снапшот — пустой план", () => {
    const plan = planSettingsMigration({});
    expect(plan.actions).toEqual([]);
    expect(plan.hadFull).toBe(false);
  });

  it("full переписывается в check-only ровно в тех scope, где он стоял", () => {
    const plan = planSettingsMigration({
      autoSyncMode: { user: "full", workspace: "check-only", folder: "full" },
    });
    expect(plan.hadFull).toBe(true);
    expect(plan.actions).toEqual([
      { key: "autoSyncMode", scope: "user", value: "check-only", kind: "rewrite-mode" },
      { key: "autoSyncMode", scope: "folder", value: "check-only", kind: "rewrite-mode" },
    ]);
  });

  it("folder-scope не теряется — регресс мульти-рут миграции", () => {
    const plan = planSettingsMigration({ autoSyncMode: { folder: "full" } });
    expect(plan.actions.map((a) => a.scope)).toEqual(["folder"]);
    expect(plan.hadFull).toBe(true);
  });

  it("check-only и off не трогаются и не включают тост", () => {
    const plan = planSettingsMigration({
      autoSyncMode: { user: "check-only", workspace: "off" },
    });
    expect(plan.actions).toEqual([]);
    expect(plan.hadFull).toBe(false);
  });

  it("удалённые ключи вычищаются из каждого scope, где есть значение", () => {
    const plan = planSettingsMigration({
      lineEnding: { user: "crlf" },
      deltaSync: { workspace: true },
      conflictRules: { user: [], folder: [{ pattern: "*.lock", strategy: "newer" }] },
    });
    expect(plan.hadFull).toBe(false);
    // Order is the declaration order of REMOVED_SETTINGS_100 — deterministic.
    expect(plan.actions).toEqual([
      { key: "deltaSync", scope: "workspace", value: undefined, kind: "remove" },
      { key: "conflictRules", scope: "user", value: undefined, kind: "remove" },
      { key: "conflictRules", scope: "folder", value: undefined, kind: "remove" },
      { key: "lineEnding", scope: "user", value: undefined, kind: "remove" },
    ]);
  });

  it("falsy-значения (false, \"\", 0) считаются установленными и вычищаются", () => {
    const plan = planSettingsMigration({
      deltaSync: { user: false },
      syncScheduleExtended: { user: "" },
      deltaThresholdKB: { workspace: 0 },
    });
    expect(plan.actions).toHaveLength(3);
  });

  it("идемпотентность: план по уже смигрированному снапшоту пуст", () => {
    const migrated = planSettingsMigration({
      autoSyncMode: { user: "check-only" },
      lineEnding: {},
    });
    expect(migrated.actions).toEqual([]);
  });

  it("список удаляемых ключей не пересекается со схемой package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
    ) as { contributes: { configuration: { properties: Record<string, unknown> } } };
    const declared = Object.keys(pkg.contributes.configuration.properties);
    const resurrected = REMOVED_SETTINGS_100.filter((k) => declared.includes(`vscodesync.${k}`));
    expect(resurrected).toEqual([]);
  });
});
