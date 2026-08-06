/**
 * v2.20.1 — split planner unit tests.
 */
import { describe, expect, it } from "vitest";
import {
  splitSettingsForSync,
  SETTINGS_SYNC_RULES,
  SettingsSyncNotImplementedError,
  trySettingsSyncSession,
} from "../../src/core/settingsSyncIntegration.js";

describe("splitSettingsForSync", () => {
  it("routes preference keys to `synced`", () => {
    const result = splitSettingsForSync({
      values: { notificationLevel: "verbose", watchMode: true },
    });
    expect(result.synced).toEqual({ notificationLevel: "verbose", watchMode: true });
    expect(result.localOnly).toEqual({});
    expect(result.unknown).toEqual([]);
  });

  it("routes secrets and machine-local to `localOnly`", () => {
    const result = splitSettingsForSync({
      values: {
        "_secret.dek": "abc",
        "_local.machineId": "m1",
        "_local.machineName": "laptop",
      },
    });
    expect(result.synced).toEqual({});
    expect(result.localOnly).toEqual({
      "_secret.dek": "abc",
      "_local.machineId": "m1",
      "_local.machineName": "laptop",
    });
    expect(result.unknown).toEqual([]);
  });

  it("flags unknown keys instead of silently leaking them", () => {
    const result = splitSettingsForSync({
      values: { somethingNew: 1, watchMode: false },
    });
    expect(result.synced).toEqual({ watchMode: false });
    expect(result.localOnly).toEqual({});
    expect(result.unknown).toEqual(["somethingNew"]);
  });

  it("preserves arbitrary value shapes (objects, nulls, arrays)", () => {
    const value = { enabled: true, activeHours: "09:00-18:00" };
    const result = splitSettingsForSync({
      values: { compressUploads: value, "_local.queue": [1, 2, 3] },
    });
    expect(result.synced.compressUploads).toBe(value);
    expect(result.localOnly["_local.queue"]).toEqual([1, 2, 3]);
  });
});

describe("SETTINGS_SYNC_RULES sanity", () => {
  it("has unique keys", () => {
    const seen = new Set<string>();
    for (const rule of SETTINGS_SYNC_RULES) {
      expect(seen.has(rule.key), `duplicate ${rule.key}`).toBe(false);
      seen.add(rule.key);
    }
  });

  it("never marks `_secret.*` or `_local.*` keys as preference", () => {
    for (const rule of SETTINGS_SYNC_RULES) {
      if (rule.key.startsWith("_secret.")) expect(rule.category).toBe("secret");
      if (rule.key.startsWith("_local.")) expect(rule.category).toBe("machine_local");
    }
  });
});

describe("trySettingsSyncSession sentinel", () => {
  it("throws SettingsSyncNotImplementedError", () => {
    expect(() => trySettingsSyncSession()).toThrow(SettingsSyncNotImplementedError);
  });
});
